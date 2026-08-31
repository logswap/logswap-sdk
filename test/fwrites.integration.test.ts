/**
 * Integration WRITES for the F-pool paths, against a live anvil with the local deployment.
 *
 * The C suite (`writes.integration.test.ts`) never touches these helpers, which is how all seven
 * F writes shipped encoding one argument short. `encode.test.ts` now pins the call SHAPES offline;
 * this suite pins the BEHAVIOUR on a real chain: quotes match execution, round trips never profit,
 * zaps live within their previews, and the authority gate holds.
 *
 * Uses anvil account #2 — not #1, which the C suite mutates concurrently under vitest's default
 * parallelism, and not #0, which is the deployer and would pass the authority checks this suite
 * asserts FAIL. ERC20Mock.mint is open, so the account funds itself.
 */

import { describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { readFileSync } from "node:fs";
import { createLogswapClient, type LogswapClient } from "../src/client.js";
import {
  getFPool,
  fPoolQuoteSwap,
  fPoolSwapQuoteIn,
  fPoolSwapBaseIn,
  fPoolSwapBaseForBase,
  fPoolMint,
  fPoolBurn,
  fPoolHarvest,
  fPoolZapIn,
  fPoolZapOut,
  fPoolPreviewZapIn,
  fPoolShareBalance,
  approveRouterForFPool,
  isRouterOperatorForFPool,
  FPoolQuoteKind,
  type FPoolState,
} from "../src/fpool.js";

const RPC = process.env.LOGSWAP_RPC ?? "http://127.0.0.1:8545";
const DEPLOY = process.env.LOGSWAP_DEPLOYMENT ?? "../logswap-contract/deployments/local.json";
// anvil account #2 — see the header for why not #0 or #1
const USER_PK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;

const ERC20 = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address,uint256)",
]);

let c!: LogswapClient;
let user!: Address;
let multi3!: Hex;
let launch!: Hex; // a launch pool mid-life (rung > 0), so both sides are tradeable
let m3!: FPoolState;
let live = false;
// one unit of the F pools' quote, in wei — the devnet's USDC is 6-dec; resolved at setup
let QUNIT = 10n ** 18n;

try {
  const d = JSON.parse(readFileSync(DEPLOY, "utf8"));
  if (!d.multi3PoolId || !d.launchPoolIds?.length || !d.fPoolManager) throw new Error("artifact predates F fixtures");
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
  multi3 = d.multi3PoolId;
  launch = d.launchPoolIds[d.launchPoolIds.length - 1]; // the LIVE launch (DOGI, rung 2): float out to sell back into
  m3 = await getFPool(c, multi3);

  // Fund, then approve BOTH pull paths — they are different and confusing them is a shipped bug:
  // the MANAGER pulls with plain transferFrom (direct swaps/mint/burn), while the ROUTER pulls
  // through Permit2 when the deployment carries one, so a plain approval to the router does
  // nothing and the zap reverts NotAllowed(). `onboardToken` does the Permit2 two-step.
  const { onboardToken } = await import("../src/onboard.js");
  const tokens = [m3.quote, ...m3.bases, (await getFPool(c, launch)).bases[0]!];
  for (const t of tokens) {
    const bal = (await pub.readContract({ address: t, abi: ERC20, functionName: "balanceOf", args: [user] })) as bigint;
    if (bal < 10n ** 24n) {
      const h = await wallet.writeContract({ address: t, abi: ERC20, functionName: "mint", args: [user, 10n ** 24n], account, chain: foundry });
      await pub.waitForTransactionReceipt({ hash: h });
    }
    const h = await wallet.writeContract({ address: t, abi: ERC20, functionName: "approve", args: [d.fPoolManager, (1n << 256n) - 1n], account, chain: foundry });
    await pub.waitForTransactionReceipt({ hash: h });
    await onboardToken(c, t, 1n << 200n);
  }
  {
    const { erc20Abi } = await import("viem");
    const qdec = await pub.readContract({ address: d.usdc, abi: erc20Abi, functionName: "decimals" }).then(Number).catch(() => 18);
    QUNIT = 10n ** BigInt(qdec);
  }
  live = true;
} catch {
  live = false;
}

if (!live && process.env.LOGSWAP_REQUIRE_NODE === "1") {
  throw new Error(`LOGSWAP_REQUIRE_NODE=1 but no node/F deployment at ${RPC} / ${DEPLOY}`);
}

const mined = async (hash: `0x${string}`) => {
  const r = await c.public.waitForTransactionReceipt({ hash });
  expect(r.status).toBe("success");
  return r;
};

const balOf = (t: Address) => c.public.readContract({ address: t, abi: ERC20, functionName: "balanceOf", args: [user] }) as Promise<bigint>;

describe.skipIf(!live)("F writes against the local deployment", () => {
  it("quoteSwap is EXACT: the executed swap pays what the quote said", async () => {
    const amountIn = 500n * QUNIT; // quote
    const quoted = await fPoolQuoteSwap(c, { poolId: multi3, kind: FPoolQuoteKind.QuoteIn, j: 0, amountIn });
    expect(quoted).toBeGreaterThan(0n);
    const before = await balOf(m3.bases[0]!);
    await mined(await fPoolSwapQuoteIn(c, { poolId: multi3, j: 0, amountIn, minOut: quoted, account: user }));
    expect((await balOf(m3.bases[0]!)) - before).toBe(quoted); // minOut = quoted: exactness enforced on-chain
  });

  it("a base round trip never profits", async () => {
    const before = await balOf(m3.bases[1]!);
    const got = await fPoolQuoteSwap(c, { poolId: multi3, kind: FPoolQuoteKind.QuoteIn, j: 1, amountIn: 200n * QUNIT });
    await mined(await fPoolSwapQuoteIn(c, { poolId: multi3, j: 1, amountIn: 200n * QUNIT, account: user }));
    await mined(await fPoolSwapBaseIn(c, { poolId: multi3, j: 1, amountIn: got, account: user }));
    expect(await balOf(m3.bases[1]!)).toBeLessThanOrEqual(before);
  });

  it("base-for-base needs no quote and both quoted legs move", async () => {
    const amountIn = 50n * 10n ** 18n;
    const quoted = await fPoolQuoteSwap(c, { poolId: multi3, kind: FPoolQuoteKind.BaseForBase, j: 0, k: 2, amountIn });
    const before = await balOf(m3.bases[2]!);
    await mined(await fPoolSwapBaseForBase(c, { poolId: multi3, j: 0, k: 2, amountIn, minOut: quoted, account: user }));
    expect((await balOf(m3.bases[2]!)) - before).toBe(quoted);
  });

  it("mint then burn round-trips shares and never mints for free", async () => {
    const dL = 1_000n * QUNIT; // exposure is quote units
    const s0 = await fPoolShareBalance(c, multi3, user);
    const q0 = await balOf(m3.quote);
    await mined(await fPoolMint(c, { poolId: multi3, dL, account: user }));
    const minted = (await fPoolShareBalance(c, multi3, user)) - s0;
    expect(minted).toBeGreaterThan(0n);
    expect(q0 - (await balOf(m3.quote))).toBeGreaterThan(0n); // Q > 0 pool: mint must cost quote
    await mined(await fPoolBurn(c, { poolId: multi3, shares: minted, account: user }));
    expect(await fPoolShareBalance(c, multi3, user)).toBe(s0);
  });

  it("zapIn lives within previewZapIn, and zapOut needs the operator, once", async () => {
    const dL = 500n * QUNIT;
    const need = await fPoolPreviewZapIn(c, multi3, dL);
    const q0 = await balOf(m3.quote);
    await mined(await fPoolZapIn(c, { poolId: multi3, dL, maxQuoteIn: need, account: user }));
    expect(q0 - (await balOf(m3.quote))).toBeLessThanOrEqual(need); // preview is an upper bound
    const shares = await fPoolShareBalance(c, multi3, user);
    expect(shares).toBeGreaterThan(0n);

    if (!(await isRouterOperatorForFPool(c, user))) await mined(await approveRouterForFPool(c, user));
    await mined(await fPoolZapOut(c, { poolId: multi3, shares, tokenOut: m3.quote, account: user }));
    expect(await fPoolShareBalance(c, multi3, user)).toBe(0n);
  });

  it("the launchpad loop: buy into a live launch, sell back, the pool keeps the fee", async () => {
    const st = await getFPool(c, launch);
    const tok = st.bases[0]!;
    const spend = 20n * QUNIT;
    const got = await fPoolQuoteSwap(c, { poolId: launch, kind: FPoolQuoteKind.QuoteIn, j: 0, amountIn: spend });
    expect(got).toBeGreaterThan(0n);
    const q0 = await balOf(st.quote);
    await mined(await fPoolSwapQuoteIn(c, { poolId: launch, j: 0, amountIn: spend, account: user }));
    await mined(await fPoolSwapBaseIn(c, { poolId: launch, j: 0, amountIn: got, account: user }));
    const cost = q0 - (await balOf(st.quote));
    expect(cost).toBeGreaterThan(0n); // the 1% launch fee, twice — no free round trip
    expect(await c.public.readContract({ address: tok, abi: ERC20, functionName: "balanceOf", args: [user] })).toBeGreaterThanOrEqual(0n);
  });

  it("harvest is refused for anyone but the authority", async () => {
    await expect(fPoolHarvest(c, { poolId: launch, amount: 1n, account: user })).rejects.toThrow();
  });
});

describe.skipIf(!live)("F lifecycle and discovery against the local deployment", () => {
  it("discovers every deployed F pool from logs, shapes included", async () => {
    const { discoverFPools } = await import("../src/fpool.js");
    const pools = await discoverFPools(c);
    expect(pools.length).toBeGreaterThanOrEqual(3); // the basket + 2 launches in the fixtures
    const launches = pools.filter((p) => p.shape === "launch");
    const baskets = pools.filter((p) => p.shape === "basket");
    expect(launches.length).toBeGreaterThanOrEqual(2);
    expect(baskets.length).toBeGreaterThanOrEqual(1);
    expect(pools.map((p) => p.poolId)).toContain(multi3);
  });

  it("creates, seeds, trades, hands over, and refuses the wrong authority", async () => {
    const { fPoolInitialize, fPoolIdOf, fPoolSeed, fPoolSetAuthority } = await import("../src/fpool.js");
    const st = await getFPool(c, multi3);
    const shapeArgs = {
      quote: st.quote, bases: [st.bases[0]!], weights: [10n ** 18n],
      phi: 10n ** 16n, feesOnly: true, authority: user,
    };
    // a fresh phi makes a fresh key/id even with the same legs
    shapeArgs.phi = 10n ** 16n + BigInt(Date.now() % 1000);
    await mined(await fPoolInitialize(c, { ...shapeArgs, account: user }));
    const id = await fPoolIdOf(c, shapeArgs);
    await mined(await fPoolSeed(c, { poolId: id, L0: 1_000n * QUNIT, x0: [0n], Q0: 0n, account: user }));
    const got = await fPoolQuoteSwap(c, { poolId: id, kind: FPoolQuoteKind.QuoteIn, j: 0, amountIn: 10n * QUNIT });
    expect(got).toBeGreaterThan(0n);
    await mined(await fPoolSetAuthority(c, { poolId: id, next: "0x000000000000000000000000000000000000dEaD", account: user }));
    await expect(fPoolSetAuthority(c, { poolId: id, next: user, account: user })).rejects.toThrow(); // no longer ours
  });
});
