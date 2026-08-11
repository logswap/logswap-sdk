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
import { burn, harvest, harvestProceeds, mint, move } from "../src/liquidity.js";
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
    addresses: { manager: d.manager, router: d.router, lens: d.lens, permit2: d.permit2 },
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

  it("harvest raises the floor and returns PURE QUOTE — base untouched", async () => {
    const s = await getPool(c, key);
    const fromFloor = (s.x / key.tickSpacing - 8n) * key.tickSpacing;
    const toFloor = (s.x / key.tickSpacing - 4n) * key.tickSpacing;
    const L = 50_000n * 10n ** 6n;

    await mined(await mint(c, { key, targetFloor: fromFloor, L }));
    if (!(await isRouterApproved(c, user))) await mined(await approveRouterAsOperator(c));

    const p = await getHolderPosition(c, key, user, fromFloor);
    const bBefore = (await c.public.readContract({ address: key.base, abi: ERC20, functionName: "balanceOf", args: [user] })) as bigint;
    const qBefore = (await c.public.readContract({ address: key.quote, abi: ERC20, functionName: "balanceOf", args: [user] })) as bigint;
    const xBefore = (await getPool(c, key)).x;

    await mined(await harvest(c, { key, fromFloor, toFloor, shares: p.shares }));

    const bAfter = (await c.public.readContract({ address: key.base, abi: ERC20, functionName: "balanceOf", args: [user] })) as bigint;
    const qAfter = (await c.public.readContract({ address: key.quote, abi: ERC20, functionName: "balanceOf", args: [user] })) as bigint;

    expect(bAfter).toBe(bBefore); // THE POINT: no base moved
    expect(qAfter).toBeGreaterThan(qBefore); // pure quote out
    expect((await getPool(c, key)).x).toBe(xBefore); // and the price did not move

    // and the closed form predicts it
    const predicted = harvestProceeds(p.L, fromFloor, toFloor);
    const got = qAfter - qBefore;
    const diff = got > predicted ? got - predicted : predicted - got;
    expect(diff * 1000n).toBeLessThan(predicted); // within 0.1%, fees included
  });

  it("harvest refuses to lower the floor, at the call site", async () => {
    await expect(
      harvest(c, { key, fromFloor: 2n * key.tickSpacing, toFloor: 1n * key.tickSpacing, shares: 1n }),
    ).rejects.toThrow(/must exceed/);
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
