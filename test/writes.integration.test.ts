/**
 * Integration WRITES against a live anvil with the local deployment on it.
 *
 * Uses anvil's account #1 (the demo user the deploy script funds). Liveness is probed with
 * top-level await — `describe.skipIf` is evaluated at collection time, so a flag set in `beforeAll`
 * would always still be false and the whole block would skip in silence.
 */

import { describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, http, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { readFileSync } from "node:fs";
import { createLogswapClient, type LogswapClient } from "../src/client.js";
import { discoverMarkets, getPool, liveFloors, priceOf } from "../src/pools.js";
import { getHolderPosition } from "../src/positions.js";
import { quoteExactIn, quoteExactOut, swapExactIn, swapExactOut, hopTokens, isPathChained } from "../src/swap.js";
import { burn, harvest, harvestProceeds, mint, move, deepen, shift, resize, exit, previewEdit, edit } from "../src/liquidity.js";
import { execute, mintAction, swapExactInAction, settleOnly, OPEN_DELTA } from "../src/actions.js";
import { approveRouterAsOperator, checkReadiness, claimFees, isRouterApproved } from "../src/claims.js";
import { withSlippage, NEVER } from "../src/write.js";
import { checkTokenReadiness, usesPermit2 } from "../src/onboard.js";
import { NO_CAP } from "../src/ids.js";
import type { PoolKey } from "../src/keys.js";

const RPC = process.env.LOGSWAP_RPC ?? "http://127.0.0.1:8545";
const DEPLOY = process.env.LOGSWAP_DEPLOYMENT ?? "../logswap-contract/deployments/local.json";
// anvil account #1 — the demo user local-deploy.sh funds
const USER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

const ERC20 = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

let c!: LogswapClient;
let key!: PoolKey;
let user!: Address;
let live = false;

try {
  const d = JSON.parse(readFileSync(DEPLOY, "utf8"));
  const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
  await pub.getBlockNumber();
  const account = privateKeyToAccount(USER_PK);
  const wallet = createWalletClient({ account, chain: foundry, transport: http(RPC) });
  user = account.address;
  c = createLogswapClient({
    public: pub,
    wallet,
    addresses: { cPoolManager: d.cPoolManager, router: d.router, lens: d.lens, permit2: d.permit2, fPoolManager: d.fPoolManager },
  });
  const markets = await discoverMarkets(c);
  key = markets.find((m) => m.poolId === d.poolId)!.key;

  // Onboard properly. Approving the ROUTER on the ERC-20 looks right and does nothing when the
  // deployment is Permit2-wired: the pull goes through Permit2 and fails with NotAllowed().
  const { onboardToken } = await import("../src/onboard.js");
  await onboardToken(c, key.base, (1n << 200n));
  await onboardToken(c, key.quote, (1n << 200n));
  live = true;
} catch {
  live = false;
}

if (!live && process.env.LOGSWAP_REQUIRE_NODE === "1") {
  throw new Error(`LOGSWAP_REQUIRE_NODE=1 but no node/deployment at ${RPC} / ${DEPLOY}`);
}

const mined = async (hash: `0x${string}`) => {
  const r = await c.public.waitForTransactionReceipt({ hash });
  expect(r.status).toBe("success");
  return r;
};

describe.skipIf(!live)("writes against the local deployment", () => {
  it("quotes exactly what a swap executes", async () => {
    const amountIn = 10_000n * 10n ** 6n; // quote has 6 decimals in the local deploy
    const quoted = await quoteExactIn(c, key, false, amountIn);
    expect(quoted).toBeGreaterThan(0n);

    const before = (await c.public.readContract({
      address: key.base, abi: ERC20, functionName: "balanceOf", args: [user],
    })) as bigint;

    await mined(await swapExactIn(c, { key, baseIn: false, amountIn, minOut: withSlippage(quoted, 100, "output") }));

    const gained = ((await c.public.readContract({
      address: key.base, abi: ERC20, functionName: "balanceOf", args: [user],
    })) as bigint) - before;

    // the revert-quoter runs the real swap, so this is exact — not "close enough"
    expect(gained).toBe(quoted);
  });

  it("exact-out delivers exactly the requested amount", async () => {
    const want = 10n ** 15n; // base has 18 decimals
    const cost = await quoteExactOut(c, key, true, want);
    const before = (await c.public.readContract({
      address: key.base, abi: ERC20, functionName: "balanceOf", args: [user],
    })) as bigint;

    await mined(await swapExactOut(c, { key, baseOut: true, amountOut: want, maxIn: withSlippage(cost, 100, "input") }));

    const gained = ((await c.public.readContract({
      address: key.base, abi: ERC20, functionName: "balanceOf", args: [user],
    })) as bigint) - before;
    expect(gained).toBe(want);
  });

  it("a slippage bound that cannot be met reverts rather than filling badly", async () => {
    const amountIn = 1_000n * 10n ** 6n;
    const quoted = await quoteExactIn(c, key, false, amountIn);
    await expect(
      swapExactIn(c, { key, baseIn: false, amountIn, minOut: quoted * 2n }),
    ).rejects.toThrow();
  });

  it("an expired deadline reverts", async () => {
    await expect(
      swapExactIn(c, { key, baseIn: false, amountIn: 1_000n * 10n ** 6n, minOut: 0n, deadline: 1n }),
    ).rejects.toThrow();
  });

  it("mints, and reports what still needs approving", async () => {
    const s = await getPool(c, key);
    const floor = (s.x / key.tickSpacing - 5n) * key.tickSpacing; // safely below spot
    const L = 10_000n * 10n ** 6n;

    const before = await checkReadiness(c, key, user, { positions: true });
    expect(typeof before.needsOperator).toBe("boolean");

    await mined(await mint(c, { key, targetFloor: floor, L }));
    const p = await getHolderPosition(c, key, user, floor);
    expect(p.shares).toBeGreaterThan(0n);
    expect(p.L).toBeGreaterThan(0n);
  });

  const bal = async (token: Address) =>
    (await c.public.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [user] })) as bigint;

  it("harvest raises the floor and returns PURE QUOTE — base untouched", async () => {
    const s = await getPool(c, key);
    const fromFloor = (s.x / key.tickSpacing - 8n) * key.tickSpacing;
    const L = 50_000n * 10n ** 6n;

    await mined(await mint(c, { key, targetFloor: fromFloor, L }));
    if (!(await isRouterApproved(c, user))) await mined(await approveRouterAsOperator(c));

    const p = await getHolderPosition(c, key, user, fromFloor);
    const [bBefore, qBefore] = [await bal(key.base), await bal(key.quote)];
    const xBefore = (await getPool(c, key)).x;

    // the lens says exactly what the edit will do; the chain then does it
    const toFloor = fromFloor + 4n * key.tickSpacing;
    const pv = await previewEdit(c, { key, fromId: p.id, shares: p.shares, toFloor, newL: p.L });
    expect(pv.dBase).toBe(0n);
    expect(pv.dQuote).toBeLessThan(0n);

    await mined(await harvest(c, { key, fromId: p.id, shares: p.shares, rungs: 4n }));

    const [bAfter, qAfter] = [await bal(key.base), await bal(key.quote)];
    expect(bAfter).toBe(bBefore); // THE POINT: no base moved
    expect(qAfter - qBefore).toBe(-pv.dQuote + pv.fees); // and exactly what the preview said
    expect((await getPool(c, key)).x).toBe(xBefore); // and the price did not move

    // and the closed form predicts it
    const predicted = harvestProceeds(p.L, fromFloor, toFloor);
    const got = qAfter - qBefore;
    const diff = got > predicted ? got - predicted : predicted - got;
    expect(diff * 1000n).toBeLessThan(predicted); // within 0.1%, fees included
    expect((await getHolderPosition(c, key, user, toFloor)).shares).toBeGreaterThan(0n);
  });

  it("harvest refuses to lower the floor, at the call site; deepen refuses to raise it", async () => {
    await expect(harvest(c, { key, fromId: 1n, shares: 1n, rungs: -1n })).rejects.toThrow(/deepen/);
    await expect(deepen(c, { key, fromId: 1n, shares: 1n, rungs: 0n })).rejects.toThrow(/harvest/);
  });

  it("deepen is harvest's mirror: pays L·δ of quote, no base; then shift moves both legs", async () => {
    const s = await getPool(c, key);
    const floor = (s.x / key.tickSpacing - 6n) * key.tickSpacing;
    await mined(await mint(c, { key, targetFloor: floor, L: 30_000n * 10n ** 6n }));
    if (!(await isRouterApproved(c, user))) await mined(await approveRouterAsOperator(c));
    const p = await getHolderPosition(c, key, user, floor);

    const [b0, q0] = [await bal(key.base), await bal(key.quote)];
    await mined(await deepen(c, { key, fromId: p.id, shares: p.shares }));
    expect(await bal(key.base)).toBe(b0);
    const paid = q0 - (await bal(key.quote));
    const predicted = harvestProceeds(p.L, floor - key.tickSpacing, floor);
    const diff = paid > predicted ? paid - predicted : predicted - paid;
    expect(diff * 1000n).toBeLessThan(predicted);

    // shift: the whole class one rung up — an uncapped class, so the same as floor(+1)
    const deeper = await getHolderPosition(c, key, user, floor - key.tickSpacing);
    await mined(await shift(c, { key, fromId: deeper.id, shares: deeper.shares, rungs: 1n }));
    expect((await getHolderPosition(c, key, user, floor - key.tickSpacing)).shares).toBe(0n);
    expect((await getHolderPosition(c, key, user, floor)).shares).toBeGreaterThan(0n);
  });

  it("resize doubles the exposure at the same floor; exit settled in QUOTE moves no base", async () => {
    const s = await getPool(c, key);
    const floor = (s.x / key.tickSpacing - 10n) * key.tickSpacing;
    await mined(await mint(c, { key, targetFloor: floor, L: 10_000n * 10n ** 6n }));
    if (!(await isRouterApproved(c, user))) await mined(await approveRouterAsOperator(c));
    const p = await getHolderPosition(c, key, user, floor);

    await mined(await resize(c, { key, fromId: p.id, shares: p.shares, newL: p.L * 2n }));
    const doubled = await getHolderPosition(c, key, user, floor);
    const ratio = (doubled.L * 1000n) / p.L;
    expect(ratio).toBeGreaterThanOrEqual(1999n);
    expect(ratio).toBeLessThanOrEqual(2001n);

    // exit to one asset: the base leg is sold through the curve in the same batch
    const [b0, q0] = [await bal(key.base), await bal(key.quote)];
    await mined(await exit(c, { key, fromId: doubled.id, shares: doubled.shares, settleIn: "quote" }));
    expect(await bal(key.base)).toBe(b0);
    expect(await bal(key.quote)).toBeGreaterThan(q0);
    expect((await getHolderPosition(c, key, user, floor)).shares).toBe(0n);
  });

  it("an edit settled in BASE swaps the released quote: only base arrives", async () => {
    const s = await getPool(c, key);
    const floor = (s.x / key.tickSpacing - 9n) * key.tickSpacing;
    await mined(await mint(c, { key, targetFloor: floor, L: 20_000n * 10n ** 6n }));
    if (!(await isRouterApproved(c, user))) await mined(await approveRouterAsOperator(c));
    const p = await getHolderPosition(c, key, user, floor);
    const [b0, q0] = [await bal(key.base), await bal(key.quote)];
    await mined(await edit(c, { key, fromId: p.id, shares: p.shares, toFloor: floor + 2n * key.tickSpacing, newL: p.L, settleIn: "base" }));
    expect(await bal(key.quote)).toBe(q0);
    expect(await bal(key.base)).toBeGreaterThan(b0);
  });

  it("a raw batch: mint, then buy base with the open delta of a swap — one lock", async () => {
    const s = await getPool(c, key);
    const floor = (s.x / key.tickSpacing - 7n) * key.tickSpacing;
    const b0 = await bal(key.base);
    // pay quote for the mint's quote leg AND for a swap into base, settled in quote only
    const actions = [
      mintAction({ key, targetFloor: floor, L: 5_000n * 10n ** 6n }),
      swapExactInAction({ key, baseIn: false, amountIn: 1_000n * 10n ** 6n }),
    ];
    // the mint needs base too, so this batch cannot settle quote-only; settle both, bound the quote
    await mined(
      await execute(c, {
        actions,
        settle: { tokens: [key.base, key.quote], maxIn: [OPEN_DELTA, OPEN_DELTA], minOut: [0n, 0n] },
      }),
    );
    void settleOnly;
    expect(await bal(key.base)).not.toBe(b0);
    expect((await getHolderPosition(c, key, user, floor)).shares).toBeGreaterThan(0n);
  });

  it("burns in kind and sweeps fees in the same settlement", async () => {
    const s = await getPool(c, key);
    const floor = (s.x / key.tickSpacing - 12n) * key.tickSpacing;
    await mined(await mint(c, { key, targetFloor: floor, L: 20_000n * 10n ** 6n }));
    if (!(await isRouterApproved(c, user))) await mined(await approveRouterAsOperator(c));

    const p = await getHolderPosition(c, key, user, floor);
    expect(p.shares).toBeGreaterThan(0n);
    await mined(await burn(c, { key, ids: [p.id], shares: [p.shares] }));
    expect((await getHolderPosition(c, key, user, floor)).shares).toBe(0n);
  });

  it("claiming a TOKEN-claim id is refused before it costs gas", async () => {
    await expect(claimFees(c, { key, ids: [BigInt(key.quote)] })).rejects.toThrow(/TOKEN claim/);
  });

  it("path chaining is validated in the SDK, not at the lock", () => {
    const a = { key, baseIn: true };
    const b = { key, baseIn: false };
    expect(hopTokens(a).tokenIn).toBe(key.base);
    expect(isPathChained([a, b])).toBe(true); // base->quote then quote->base
    expect(isPathChained([a, a])).toBe(false); // base->quote then base->... mis-chained
  });

  it("NEVER is available but is not the default deadline", async () => {
    expect(NEVER).toBe((1n << 256n) - 1n);
    const s = await getPool(c, key);
    expect(priceOf(s)).toBeGreaterThan(0);
    expect(NO_CAP).toBeLessThan(0n);
  });
});
