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
 * Decimals are immutable for the life of a token: ERC-20 exposes no way to change them, and a token
 * that did would break every integration, not just this one. That is what makes an unbounded TTL
 * correct rather than merely convenient.
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
}

const memory = new Map<string, string>();

/** The default: per-process, no persistence. Works in node, workers and a browser alike. */
export const memoryStore: TokenStore = {
  get: (k) => memory.get(k) ?? null,
  set: (k, v) => void memory.set(k, v),
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

export function readCachedToken(chainId: number, address: Address): CachedToken | null {
  const raw = store.get(keyOf(chainId, address));
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
  store.set(keyOf(chainId, address), JSON.stringify({ symbol: t.symbol, decimals: t.decimals }));
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
  onClear.forEach((f) => f());
}

const onClear = new Set<() => void>();

/** Internal: lets `pools.ts` drop its in-flight map when the cache is cleared. */
export function registerCacheClear(f: () => void): void {
  onClear.add(f);
}
