/**
 * Encode-level regression for EVERY write helper — no chain, no wallet, no skipIf.
 *
 * Why this exists: the F-pool write helpers shipped broken — `writeFPool` accepted `poolId` and
 * silently dropped it, so all seven encoded one argument short. tsc never saw it (the helpers cast
 * through `as never`), the integration suite never saw it (it covers the C paths, and it skips
 * without a node), and 183 tests passed around it. The failure only existed at viem's encode step:
 * "ABI encoding params/values length mismatch".
 *
 * So this suite runs exactly that step. A fake client routes `simulateContract` /
 * `estimateContractGas` / `readContract` / `writeContract` through `encodeFunctionData` against
 * the REAL generated ABI, which throws on any arity or type drift. If a helper builds its args
 * wrong — today's bug or the next signature change — it fails here, offline, in milliseconds.
 *
 * The fake is deliberately dumb: it validates encoding and returns inert values. Behaviour
 * (amounts, reverts, settlement) belongs to the integration suites; ONLY the call shape lives here.
 */

import { describe, expect, it } from "vitest";
import { encodeFunctionData, toFunctionSelector, type Address, type Hex } from "viem";
import { foundry } from "viem/chains";
import { createLogswapClient, type LogswapClient } from "../src/client.js";
import { mint, zapIn, update, move, harvest, deepen, floor, cap, shift, resize, exit, reprice, edit, burn } from "../src/liquidity.js";
import { execute, mintAction, swapExactInAction, settleInKind, OPEN_DELTA } from "../src/actions.js";
import { swapExactIn, swapExactOut, swapExactInPath } from "../src/swap.js";
import { claimFees, approveRouterAsOperator } from "../src/claims.js";
import { approveToken, approvePermit2ForRouter } from "../src/onboard.js";
import { initializeMarket } from "../src/pools.js";
import {
  fPoolInitialize,
  fPoolSeed,
  fPoolDissolve,
  fPoolProposeAuthority,
  fPoolAcceptAuthority,
  fPoolSetGates,
  fPoolSetAllowed,
  fPoolAppointOperator,
  fPoolRaiseMinBuffer,
  fPoolSetLegL,
  fPoolAdmitLeg,
  fPoolTransferShares,
  fPoolSwapQuoteIn,
  fPoolSwapBaseIn,
  fPoolSwapBaseForBase,
  fPoolMint,
  fPoolBurn,
  fPoolHarvest,
  fPoolDeepen,
  fPoolZapIn,
  fPoolZapOut,
  fPoolQuoteSwap,
  fPoolPreviewZapIn,
  approveRouterForFPool,
  FPoolQuoteKind,
} from "../src/fpool.js";
import type { PoolKey } from "../src/keys.js";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const HASH = ("0x" + "11".repeat(32)) as Hex;
const POOL = ("0x" + "22".repeat(32)) as Hex;
const QUOTE_RESULT = (toFunctionSelector("QuoteResult(uint256)") + "1".padStart(64, "0")) as Hex;

const KEY: PoolKey = { base: A(0xb), quote: A(0xc), tickSpacing: 10n ** 17n, phiMin: 0n, kappa: 0n, alpha: 0n };

/** Every RPC-shaped entry point funnels into `encodeFunctionData`, which is the assertion. */
function fakeClient(): { c: LogswapClient; encoded: string[] } {
  const encoded: string[] = [];
  const check = (p: { abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) => {
    encodeFunctionData({ abi: p.abi, functionName: p.functionName, args: p.args } as never); // throws on drift
    encoded.push(p.functionName);
  };
  const pub = {
    simulateContract: async (p: never) => {
      check(p);
      // the revert-quoter must revert; hand it a QuoteResult the decoder can find
      if ((p as { functionName: string }).functionName === "quoteSwap") throw { data: QUOTE_RESULT };
      return { request: p, result: 0n };
    },
    estimateContractGas: async (p: never) => (check(p), 100_000n),
    readContract: async (p: never) => {
      check(p);
      const q = p as unknown as { functionName: string; args?: readonly unknown[]; address?: string };
      // permit2.allowance returns the packed triple; getFPool's reads return pool-shaped values
      if (q.functionName === "allowance" && (q.args?.length ?? 0) === 3) return [0n, 0, 0];
      if (q.functionName === "getPool") {
        return { quote: A(0xc), phi: 10n ** 16n, L: 10n ** 21n, Q: 0n, theta0: 0n, leverTheta: 0n,
          bigSigma: 0n, authority: A(0xa), feesOnly: true, seeded: true, dissolved: false, n: 1, shares: 10n ** 21n,
          // the private-pool fields (contracts 25a7bcf): a decode that drops one is a runtime
          // TypeError in the browser, which is what this fake exists to catch first
          pendingAuthority: A(0), operator: A(0), minBuffer: 0n, gateMint: false, gateSwap: false,
          restructureBlock: 0, incomeTaken: 0n, name: `0x${"0".repeat(64)}` };
      }
      if (q.functionName === "legOf") return [A(0xb), 10n ** 18n, 0n, 10n ** 21n];
      if (q.functionName === "shareIdOf") return (1n << 255n) | (BigInt(POOL) >> 1n);
      // the edit tree reads the class (lens.unpack + positions) and previews (lens.previewUpdate)
      if (q.functionName === "unpack") return [POOL, -5n, 10n, true];
      if (q.functionName === "positions") return [10n ** 21n, 10n ** 21n, 0n, 0n];
      if (q.functionName === "previewUpdate") return [0n, -(10n ** 18n), 3n];
      if (q.functionName === "totalSupply") return 10n ** 21n;
      return 0n;
    },
    getChainId: async () => 31337,
  };
  const wallet = {
    account: { address: A(0xa), type: "json-rpc" },
    chain: foundry,
    writeContract: async (p: never) => {
      const q = p as { abi?: readonly unknown[]; functionName?: string };
      if (q.abi && q.functionName) check(p);
      return HASH;
    },
    // the signature path: a permit is SIGNED, never sent — the fake returns a well-formed sig
    signTypedData: async () => ("0x" + "ab".repeat(65)) as `0x${string}`,
  };
  const c = createLogswapClient({
    public: pub as never,
    wallet: wallet as never,
    addresses: { cPoolManager: A(1), router: A(2), lens: A(3), fPoolManager: A(4), permit2: A(5) },
  });
  return { c, encoded };
}

describe("every C write helper encodes against the generated ABI", () => {
  it("mint → mintBlended", async () => {
    const { c } = fakeClient();
    await expect(mint(c, { key: KEY, targetFloor: -5n * 10n ** 17n, L: 10n ** 18n })).resolves.toBe(HASH);
  });
  it("zapIn", async () => {
    const { c } = fakeClient();
    await expect(zapIn(c, { key: KEY, fundWithBase: false, amountIn: 10n ** 18n, targetFloor: -5n * 10n ** 17n, L: 10n ** 18n })).resolves.toBe(HASH);
  });
  it("update", async () => {
    const { c } = fakeClient();
    await expect(update(c, { key: KEY, fromId: 1n, shares: 1n, toFloor: 0n, newL: 10n ** 18n })).resolves.toBe(HASH);
  });
  it("move", async () => {
    const { c } = fakeClient();
    await expect(move(c, { key: KEY, fromId: 1n, shares: 1n, toFloor: 0n })).resolves.toBe(HASH);
  });
  it("the edit tree: floor / harvest / deepen / cap / shift / resize / exit / reprice → execute", async () => {
    const { c, encoded } = fakeClient();
    const base = { key: KEY, fromId: 1n, shares: 1n };
    await expect(floor(c, { ...base, rungs: 2n })).resolves.toBe(HASH);
    await expect(harvest(c, base)).resolves.toBe(HASH);
    await expect(deepen(c, { ...base, rungs: 3n })).resolves.toBe(HASH);
    await expect(cap(c, { ...base, rungs: -1n })).resolves.toBe(HASH);
    await expect(shift(c, { ...base, rungs: -2n })).resolves.toBe(HASH);
    await expect(resize(c, { ...base, newL: 5n })).resolves.toBe(HASH);
    await expect(exit(c, base)).resolves.toBe(HASH);
    await expect(reprice(c, { ...base, toFloor: 10n ** 18n })).resolves.toBe(HASH);
    // a batch rides inside the Permit2 multicall when allowances are missing (the fake says they are)
    expect(encoded.filter((f) => f === "execute" || f === "multicall").length).toBeGreaterThanOrEqual(8);
    await expect(harvest(c, { ...base, rungs: -1n })).rejects.toThrow(/deepen/);
    await expect(deepen(c, { ...base, rungs: 0n })).rejects.toThrow(/harvest/);
  });
  it("an edit settled in ONE token appends the netting swap", async () => {
    const { c, encoded } = fakeClient();
    // the fake preview releases quote (dQuote < 0): settling in base sells it with an exact-in
    await expect(edit(c, { key: KEY, fromId: 1n, shares: 1n, toFloor: 0n, newL: 1n, settleIn: "base" })).resolves.toBe(HASH);
    await expect(edit(c, { key: KEY, fromId: 1n, shares: 1n, toFloor: 0n, newL: 1n, settleIn: "quote" })).resolves.toBe(HASH);
    // two sends, each encoded twice (the gas estimate, then the write)
    expect(encoded.filter((f) => f === "execute" || f === "multicall").length).toBe(4);
  });
  it("execute, raw", async () => {
    const { c } = fakeClient();
    const actions = [mintAction({ key: KEY, targetFloor: 0n, L: 1n }), swapExactInAction({ key: KEY, baseIn: false, amountIn: OPEN_DELTA })];
    await expect(execute(c, { actions, settle: settleInKind(KEY, A(0xa)) })).resolves.toBe(HASH);
  });
  it("burn", async () => {
    const { c } = fakeClient();
    await expect(burn(c, { key: KEY, ids: [1n], shares: [1n] })).resolves.toBe(HASH);
  });
  it("swapExactIn / swapExactOut / swapExactInPath", async () => {
    const { c } = fakeClient();
    await expect(swapExactIn(c, { key: KEY, baseIn: false, amountIn: 1n, minOut: 0n })).resolves.toBe(HASH);
    await expect(swapExactOut(c, { key: KEY, baseOut: true, amountOut: 1n, maxIn: 2n ** 128n })).resolves.toBe(HASH);
    await expect(swapExactInPath(c, { hops: [{ key: KEY, baseIn: false }], amountIn: 1n, minOut: 0n })).resolves.toBe(HASH);
  });
  it("claimFees + operator approval", async () => {
    const { c } = fakeClient();
    await expect(claimFees(c, { key: KEY, ids: [(1n << 255n) | 1n] })).resolves.toBe(HASH); // bit 255 = position
    await expect(approveRouterAsOperator(c)).resolves.toBe(HASH);
  });
  it("token onboarding, ERC-20 and Permit2 legs", async () => {
    const { c } = fakeClient();
    await expect(approveToken(c, A(0xb), 1n)).resolves.toBe(HASH);
    await expect(approvePermit2ForRouter(c, A(0xb))).resolves.toBe(HASH);
  });
});

describe("every F write helper encodes against the generated ABI", () => {
  // The seven F writes are the regression class: each once encoded an argument short. The three
  // swaps now route through the ROUTER's overloaded swapExactIn — this also pins viem's overload
  // resolution to the F arity (8 args) rather than the C one (6).
  it("all three swaps resolve the router's swapExactIn overload", async () => {
    const { c, encoded } = fakeClient();
    await expect(fPoolSwapQuoteIn(c, { poolId: POOL, j: 0, amountIn: 1n, account: A(0xa) })).resolves.toBe(HASH);
    await expect(fPoolSwapBaseIn(c, { poolId: POOL, j: 1, amountIn: 1n, account: A(0xa) })).resolves.toBe(HASH);
    await expect(fPoolSwapBaseForBase(c, { poolId: POOL, j: 0, k: 1, amountIn: 1n, account: A(0xa) })).resolves.toBe(HASH);
    // The fake reports NO Permit2 allowance, so each swap takes the one-transaction path:
    // reads, a SIGNED permit (signTypedData, no tx), and ONE multicall carrying applyPermit2 +
    // the swap. The write leaving the fake must therefore be multicall, never a bare swap
    // preceded by approval transactions — that is the rationalized flow, asserted.
    expect(encoded).toContain("multicall");
    expect(encoded).not.toContain("approve");
  });
  it("mint / burn", async () => {
    const { c } = fakeClient();
    await expect(fPoolMint(c, { poolId: POOL, dL: 10n ** 18n, account: A(0xa) })).resolves.toBe(HASH);
    await expect(fPoolBurn(c, { poolId: POOL, shares: 1n, account: A(0xa) })).resolves.toBe(HASH);
  });
  it("the floor lever: harvest / deepen", async () => {
    const { c } = fakeClient();
    await expect(fPoolHarvest(c, { poolId: POOL, amount: 1n, account: A(0xa) })).resolves.toBe(HASH);
    await expect(fPoolDeepen(c, { poolId: POOL, amount: 1n, account: A(0xa) })).resolves.toBe(HASH);
  });
  it("zaps resolve the ROUTER's overloaded zapIn to the F arity", async () => {
    const { c } = fakeClient();
    await expect(fPoolZapIn(c, { poolId: POOL, dL: 10n ** 18n, maxQuoteIn: 10n ** 18n, account: A(0xa) })).resolves.toBe(HASH);
    await expect(fPoolZapOut(c, { poolId: POOL, shares: 1n, tokenOut: A(0xb), account: A(0xa) })).resolves.toBe(HASH);
  });
  it("operator approval for zapOut", async () => {
    const { c } = fakeClient();
    await expect(approveRouterForFPool(c, A(0xa))).resolves.toBe(HASH);
  });
  it("the revert-quoter round-trips through the fake's QuoteResult", async () => {
    const { c } = fakeClient();
    await expect(fPoolQuoteSwap(c, { poolId: POOL, kind: FPoolQuoteKind.QuoteIn, j: 0, amountIn: 1n })).resolves.toBe(1n);
    await expect(fPoolQuoteSwap(c, { poolId: POOL, kind: FPoolQuoteKind.BaseForBase, j: 0, k: 1, amountIn: 1n })).resolves.toBe(1n);
  });
  it("the lifecycle: initialize / seed / dissolve / proposeAuthority / acceptAuthority", async () => {
    const { c } = fakeClient();
    await expect(
      fPoolInitialize(c, {
        quote: A(0xc), bases: [A(0xb), A(0x9)], weights: [4n * 10n ** 17n, 6n * 10n ** 17n],
        phi: 10n ** 16n, feesOnly: true, authority: A(0xa), account: A(0xa),
      }),
    ).resolves.toBe(HASH);
    await expect(fPoolSeed(c, { poolId: POOL, L0: 10n ** 21n, x0: [0n, 0n], Q0: 0n, account: A(0xa) })).resolves.toBe(HASH);
    await expect(fPoolDissolve(c, { poolId: POOL, account: A(0xa) })).resolves.toBe(HASH);
    await expect(fPoolProposeAuthority(c, { poolId: POOL, next: A(0xb), account: A(0xa) })).resolves.toBe(HASH);
    await expect(fPoolAcceptAuthority(c, { poolId: POOL, account: A(0xb) })).resolves.toBe(HASH);
  });
  it("the sponsor's controls and the desk encode", async () => {
    const { c } = fakeClient();
    await expect(fPoolSetGates(c, { poolId: POOL, gateMint: true, gateSwap: false, account: A(0xa) })).resolves.toBe(HASH);
    await expect(fPoolSetAllowed(c, { poolId: POOL, who: [A(0xb), A(0xc)], allowed: true, account: A(0xa) })).resolves.toBe(HASH);
    await expect(fPoolAppointOperator(c, { poolId: POOL, operator: A(0xd), account: A(0xa) })).resolves.toBe(HASH);
    await expect(fPoolRaiseMinBuffer(c, { poolId: POOL, minBuffer: 223143551314209755n, account: A(0xa) })).resolves.toBe(HASH);
    await expect(fPoolSetLegL(c, { poolId: POOL, j: 1, newLj: 10n ** 21n, account: A(0xd) })).resolves.toBe(HASH);
    await expect(fPoolSetLegL(c, { poolId: POOL, j: 2, newLj: 10n ** 21n, x: 0n, account: A(0xd) })).resolves.toBe(HASH);
    await expect(fPoolAdmitLeg(c, { poolId: POOL, base: A(0xe), Lj: 10n ** 21n, x: -(10n ** 18n), account: A(0xd) })).resolves.toBe(HASH);
    await expect(fPoolTransferShares(c, { poolId: POOL, to: A(0xdead), shares: 5n, account: A(0xa) })).resolves.toBe(HASH);
  });
  it("C market creation encodes", async () => {
    const { c } = fakeClient();
    await expect(initializeMarket(c, { key: KEY, x0: 0n, account: A(0xa) })).resolves.toBe(HASH);
  });
  it("previewZapIn reads with the right shape", async () => {
    const { c } = fakeClient();
    await expect(fPoolPreviewZapIn(c, POOL, 10n ** 18n)).resolves.toBe(0n);
  });
});
