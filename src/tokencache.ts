/**
 * tokencache.ts — remember token metadata so it is read once, not once per screen.
 *
 * `marketTokens` costs four reads per market and every screen calls it. On two markets that is
 * free; on fifty it is a hundred round trips on every navigation, over a tunnel.
 *
 * **A cache over a value that becomes a transaction amount is a way to be wrong, so three rules
 * hold here and are enforced by tests:**
 *
 * 1. **Only successes are stored.** The previous fix made a failed `decimals()` read throw rather
 *    than assume 18; caching a failure would reintroduce that bug with a longer half-life.
 * 2. **The key includes the chain id.** The same address is a different token on a different
 *    chain — a mock USDC at 18 decimals on a devnet, the real one at 6 on mainnet. Keying on
 *    address alone is the classic version of this bug and it survives a page reload.
 * 3. **A fallback symbol is never stored.** `symbol` degrades to `0x5FbD…` on failure, which is
 *    fine as a label but must not be persisted — one blip would name the token that forever.
 *
 * 4. **A resettable chain never reaches the persistent store.** Rule 3's premise is that decimals
 *    are immutable *for the life of a token*, and the key's premise is that an address names one
 *    token forever. Both hold on a public chain. Neither holds on a local one: restart anvil and
 *    the very same deterministic addresses come back holding DIFFERENT contracts. That is not
 *    hypothetical — a `logswap.token.31337:0x5fbd…` entry saying USDC has 18 decimals outlived the
 *    deploy that wrote it and made every quote-denominated number in the app read as zero, with
 *    nothing anywhere reporting a fault. Those chains get the memory store, so a page reload is
 *    enough to correct them.
 *
 * Decimals are immutable for the life of a token: ERC-20 exposes no way to change them, and a token
 * that did would break every integration, not just this one. That is what makes an unbounded TTL
 * correct rather than merely convenient — on a chain whose addresses are permanent.
 */

import type { Address } from "viem";

export interface CachedToken {
  symbol: string;
  decimals: number;
}

/** Somewhere to keep entries. Sync and tiny on purpose — `localStorage` fits, and so does a Map. */
export interface TokenStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  /** Drop everything this store owns. Optional: a store that cannot enumerate may omit it. */
  clear?(): void;
}

const memory = new Map<string, string>();

/** The default: per-process, no persistence. Works in node, workers and a browser alike. */
export const memoryStore: TokenStore = {
  get: (k) => memory.get(k) ?? null,
  set: (k, v) => void memory.set(k, v),
  clear: () => memory.clear(),
};

/**
 * `localStorage`, when there is one. Returns the memory store otherwise, so a caller never has to
 * branch on the environment — and a browser in private mode degrades instead of throwing.
 */
export function browserStore(prefix = "logswap.token."): TokenStore {
  try {
    if (typeof localStorage === "undefined") return memoryStore;
    localStorage.getItem(`${prefix}probe`); // Safari private mode throws on access, not on use
    return {
      get: (k) => {
        try {
          return localStorage.getItem(prefix + k);
        } catch {
          return null;
        }
      },
      set: (k, v) => {
        try {
          localStorage.setItem(prefix + k, v);
        } catch {
          /* quota or private mode — the cache is an optimisation, never a requirement */
        }
      },
      // Only this prefix, never the whole of localStorage: the app's own keys live there too.
      clear: () => {
        try {
          for (const k of Object.keys(localStorage)) if (k.startsWith(prefix)) localStorage.removeItem(k);
        } catch {
          /* nothing to do — see set */
        }
      },
    };
  } catch {
    return memoryStore;
  }
}

let store: TokenStore = memoryStore;

/** Swap the backing store. Call once at startup; `browserStore()` is the usual argument. */
export function setTokenStore(s: TokenStore): void {
  store = s;
}

/** Address casing varies by source, so normalise — otherwise the same token gets two entries. */
const keyOf = (chainId: number, address: Address) => `${chainId}:${address.toLowerCase()}`;

/**
 * Chains whose addresses are not permanent identities: a development node can be wiped and
 * redeployed, and because deployment addresses are derived from a deterministic nonce sequence the
 * SAME address comes back holding a different contract. 1337 is ganache's and hardhat's legacy id,
 * 31337 anvil's and hardhat's default, 31338 and 31339 the unimod and logswap devnets — both
 * persisted with `--state`, both documented as resettable by deleting that file.
 *
 * Add to this set rather than removing from it: a chain wrongly listed here costs some RPC round
 * trips, while one wrongly absent silently serves a stale scale, which is the bug this exists for.
 */
export const RESETTABLE_CHAINS: ReadonlySet<number> = new Set([1337, 31337, 31338, 31339]);

/** True when a `(chainId, address)` pair cannot be trusted to name one contract forever. */
export function isResettableChain(chainId: number): boolean {
  return RESETTABLE_CHAINS.has(chainId);
}

/**
 * The store an entry for this chain may use. A resettable chain gets memory — good enough to stop
 * one navigation re-reading the same token fifty times, and gone on reload, which is exactly the
 * lifetime over which its addresses can be trusted.
 */
const storeFor = (chainId: number): TokenStore => (isResettableChain(chainId) ? memoryStore : store);

export function readCachedToken(chainId: number, address: Address): CachedToken | null {
  const raw = storeFor(chainId).get(keyOf(chainId, address));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as CachedToken;
    // Validate on the way OUT as well as in: the store is shared with other tabs and other builds,
    // and a corrupt entry must be ignored rather than trusted.
    if (typeof v?.decimals !== "number" || !Number.isInteger(v.decimals) || v.decimals < 0 || v.decimals > 36) {
      return null;
    }
    if (typeof v.symbol !== "string" || v.symbol === "") return null;
    return v;
  } catch {
    return null;
  }
}

export function writeCachedToken(chainId: number, address: Address, t: CachedToken): void {
  storeFor(chainId).set(keyOf(chainId, address), JSON.stringify({ symbol: t.symbol, decimals: t.decimals }));
}

/**
 * Forget everything, including reads still in flight.
 *
 * For tests, and for a devnet that redeployed its mocks to the same addresses — the one case where
 * a token at a known address legitimately changes its decimals, because it is a different contract
 * wearing the same address.
 */
export function clearTokenCache(): void {
  memory.clear();
  // The persistent store too. It did not used to be, which made this function useless against the
  // one situation its own doc names: the entry that survives a redeploy lives in `localStorage`,
  // so clearing only memory left it in place and the next read served it straight back.
  store.clear?.();
  onClear.forEach((f) => f());
}

const onClear = new Set<() => void>();

/** Internal: lets `pools.ts` drop its in-flight map when the cache is cleared. */
export function registerCacheClear(f: () => void): void {
  onClear.add(f);
}
