/**
 * The property under test is a negative one: marketTokens must never invent a scale.
 *
 * A silent default to 18 is how this stack's worst bug looked — the app rendered, the contracts
 * were fine, and every amount was out by a factor of 10^12. So the test asserts that a token whose
 * decimals() cannot be read produces an ERROR, not a number.
 */
import { describe, expect, it, vi } from "vitest";
import { marketTokens } from "../src/pools.js";
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

const client = (readContract: (a: { functionName: string; address: string }) => Promise<unknown>) =>
  ({ public: { readContract }, addresses: {} } as unknown as LogswapClient);

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
