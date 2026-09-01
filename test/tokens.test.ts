/**
 * The property under test is a negative one: marketTokens must never invent a scale.
 *
 * A silent default to 18 is how this stack's worst bug looked — the app rendered, the contracts
 * were fine, and every amount was out by a factor of 10^12. So the test asserts that a token whose
 * decimals() cannot be read produces an ERROR, not a number.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { marketTokens } from "../src/pools.js";
import {
  clearTokenCache,
  isResettableChain,
  memoryStore,
  setTokenStore,
  type TokenStore,
} from "../src/tokencache.js";
import type { LogswapClient } from "../src/client.js";
import type { PoolKey } from "../src/keys.js";

const KEY = {
  base: "0x1111111111111111111111111111111111111111",
  quote: "0x2222222222222222222222222222222222222222",
  tickSpacing: 10n ** 17n,
  fee: 0n,
  phi: 0n,
  flags: 0n,
} as unknown as PoolKey;

const client = (
  readContract: (a: { functionName: string; address: string }) => Promise<unknown>,
  chainId = 31339,
) => ({ public: { readContract, chain: { id: chainId } }, addresses: {} } as unknown as LogswapClient);

// Every test starts from an empty cache; otherwise one test's hit silently satisfies the next.
beforeEach(() => {
  setTokenStore(memoryStore);
  clearTokenCache();
});

describe("marketTokens", () => {
  it("reads decimals from the token rather than assuming", async () => {
    const t = await marketTokens(
      client(async ({ functionName, address }) =>
        functionName === "decimals" ? (address === KEY.base ? 8 : 6) : "TKN",
      ),
      KEY,
    );
    expect(t.base.decimals).toBe(8);
    expect(t.quote.decimals).toBe(6);
  });

  it("THROWS rather than defaulting to 18 when decimals cannot be read", async () => {
    await expect(
      marketTokens(
        client(async ({ functionName }) => {
          if (functionName === "decimals") throw new Error("execution reverted");
          return "TKN";
        }),
        KEY,
      ),
    ).rejects.toThrow(/could not read decimals/);
  });

  it("rejects an implausible decimals value instead of trusting it", async () => {
    await expect(
      marketTokens(client(async ({ functionName }) => (functionName === "decimals" ? 250 : "TKN")), KEY),
    ).rejects.toThrow(/could not read decimals/);
  });

  it("retries a transient failure before giving up", async () => {
    let calls = 0;
    const t = await marketTokens(
      client(async ({ functionName }) => {
        if (functionName !== "decimals") return "TKN";
        calls++;
        if (calls <= 2) throw new Error("connection reset"); // first call for each token side
        return 6;
      }),
      KEY,
    );
    expect(t.quote.decimals).toBe(6);
    expect(calls).toBeGreaterThan(2);
  });

  it("still falls back for symbol, which is a label and not a scale", async () => {
    const t = await marketTokens(
      client(async ({ functionName }) => {
        if (functionName === "symbol") throw new Error("no symbol()");
        return 18;
      }),
      KEY,
    );
    expect(t.base.symbol).toBe("0x1111");
    expect(t.base.decimals).toBe(18); // read, not assumed
  });
});

describe("token cache", () => {
  it("reads once and serves the rest from cache", async () => {
    let reads = 0;
    const c = client(async ({ functionName }) => {
      if (functionName === "decimals") { reads++; return 6; }
      return "USDC";
    });
    await marketTokens(c, KEY);
    expect(reads).toBe(2); // base and quote, both cold
    await marketTokens(c, KEY);
    await marketTokens(c, KEY);
    expect(reads).toBe(2); // still 2 — nothing re-read
  });

  it("shares one read between concurrent callers for the same token", async () => {
    let reads = 0;
    const c = client(async ({ functionName }) => {
      if (functionName === "decimals") {
        reads++;
        await new Promise((r) => setTimeout(r, 10));
        return 18;
      }
      return "TKN";
    });
    // Same key three times at once: 2 distinct tokens, so 2 reads, not 6.
    await Promise.all([marketTokens(c, KEY), marketTokens(c, KEY), marketTokens(c, KEY)]);
    expect(reads).toBe(2);
  });

  it("keys on the chain — the same address is a different token elsewhere", async () => {
    // A mock USDC at 18 on the devnet; the real one at 6 on mainnet. Same address.
    await marketTokens(client(async ({ functionName }) => (functionName === "decimals" ? 18 : "USDC"), 31339), KEY);
    const main = await marketTokens(
      client(async ({ functionName }) => (functionName === "decimals" ? 6 : "USDC"), 1),
      KEY,
    );
    expect(main.quote.decimals).toBe(6); // NOT 18 from the devnet entry
  });

  it("never caches a failure — a later read still gets the truth", async () => {
    let fail = true;
    const c = client(async ({ functionName }) => {
      if (functionName !== "decimals") return "TKN";
      if (fail) throw new Error("execution reverted");
      return 6;
    });
    await expect(marketTokens(c, KEY)).rejects.toThrow(/could not read decimals/);
    fail = false;
    const t = await marketTokens(c, KEY);
    expect(t.quote.decimals).toBe(6);
  });

  it("never caches the fallback symbol, so one blip cannot name a token 0x…", async () => {
    let symbolWorks = false;
    const c = client(async ({ functionName }) => {
      if (functionName === "decimals") return 18;
      if (!symbolWorks) throw new Error("no symbol()");
      return "WETH";
    });
    const first = await marketTokens(c, KEY);
    expect(first.base.symbol).toBe("0x1111"); // the fallback, used but not stored
    symbolWorks = true;
    const second = await marketTokens(c, KEY);
    expect(second.base.symbol).toBe("WETH"); // re-read, because the fallback was not cached
  });

  it("ignores a corrupt or implausible cache entry rather than trusting it", async () => {
    setTokenStore({
      get: () => JSON.stringify({ symbol: "EVIL", decimals: 999 }),
      set: () => {},
    });
    const t = await marketTokens(
      client(async ({ functionName }) => (functionName === "decimals" ? 6 : "USDC")),
      KEY,
    );
    expect(t.quote.decimals).toBe(6); // read from chain, not the poisoned 999
  });
});

describe("a resettable chain never reaches the persistent store", () => {
  /** A stand-in for `localStorage`: survives a "reload", and can be inspected. */
  const persistent = () => {
    const backing = new Map<string, string>();
    const s: TokenStore = {
      get: (k) => backing.get(k) ?? null,
      set: (k, v) => void backing.set(k, v),
      clear: () => backing.clear(),
    };
    return { store: s, backing };
  };

  it("classifies the dev chains and leaves the public ones alone", () => {
    expect(isResettableChain(31337)).toBe(true); // anvil / hardhat default
    expect(isResettableChain(31339)).toBe(true); // the logswap devnet
    expect(isResettableChain(1)).toBe(false); // mainnet
    expect(isResettableChain(8453)).toBe(false); // base
  });

  it("writes nothing durable for a local chain, so a reload re-reads", async () => {
    const { store, backing } = persistent();
    setTokenStore(store);
    await marketTokens(client(async ({ functionName }) => (functionName === "decimals" ? 18 : "USDC"), 31337), KEY);
    expect(backing.size).toBe(0); // memory only — nothing outlives the page
  });

  it("still persists a public chain, which is what the cache is for", async () => {
    const { store, backing } = persistent();
    setTokenStore(store);
    await marketTokens(client(async ({ functionName }) => (functionName === "decimals" ? 6 : "USDC"), 1), KEY);
    expect(backing.size).toBe(2); // base and quote
  });

  /**
   * The actual incident. Anvil is redeployed, the deterministic addresses come back holding
   * different mocks, and the page reloads. Before the fix the 18 written by the first deploy
   * survived in `localStorage` and every quote amount rendered 10^12 too small.
   */
  it("does not serve a redeployed token's old decimals after a reload", async () => {
    const { store, backing } = persistent();
    // The entry as it actually survived: written durably by an earlier build, against the same
    // deterministic address, before the chain was wiped and redeployed. Seeded directly rather
    // than via a write + clearTokenCache, because a real reload calls neither — and a test that
    // clears the store on its way through proves nothing about the store surviving.
    backing.set(`31337:${(KEY.quote as string).toLowerCase()}`, JSON.stringify({ symbol: "USDC", decimals: 18 }));
    setTokenStore(store);

    const after = await marketTokens(
      client(async ({ functionName }) => (functionName === "decimals" ? 6 : "USDC"), 31337),
      KEY,
    );
    expect(after.quote.decimals).toBe(6); // the redeployed truth, not the stale 18
  });

  it("clearTokenCache empties the persistent store too, not just memory", async () => {
    const { store, backing } = persistent();
    setTokenStore(store);
    await marketTokens(client(async ({ functionName }) => (functionName === "decimals" ? 6 : "USDC"), 1), KEY);
    expect(backing.size).toBe(2);
    clearTokenCache();
    expect(backing.size).toBe(0); // used to survive, which made the function useless here
  });
});
