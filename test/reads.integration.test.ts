/**
 * Integration reads against a live anvil with the local deployment on it.
 *
 * Skips when no node is reachable — but unlike the fork test this replaced in the contracts repo,
 * CI *does* run it: the workflow starts anvil and deploys, so it is a standing guard rather than a
 * test that silently never executes. Locally:
 *
 *     cd ../logswap-contract && anvil &  && ./script/local-deploy.sh
 *     npm test
 */

import { describe, expect, it } from "vitest";
import { createPublicClient, http, type Address } from "viem";
import { foundry } from "viem/chains";
import { readFileSync } from "node:fs";
import { createLogswapClient, assertVersion, type LogswapClient } from "../src/client.js";
import { discoverMarkets, getPool, isValidFloor, liveFloors, lpEdge, phiEff, priceOf } from "../src/pools.js";
import { balanceOf, describeId, getHolderPosition, partitionIds } from "../src/positions.js";
import { claimId, isPosition, NO_CAP } from "../src/ids.js";
import { poolId, type PoolKey } from "../src/keys.js";

const RPC = process.env.LOGSWAP_RPC ?? "http://127.0.0.1:8545";
const DEPLOY = process.env.LOGSWAP_DEPLOYMENT ?? "../logswap-contract/deployments/local.json";

// Liveness is probed with TOP-LEVEL AWAIT, not in beforeAll: `describe.skipIf` is evaluated at
// COLLECTION time, so a flag set in beforeAll is always still false and the whole block skips
// silently — which is precisely the "test that never runs" failure this suite exists to avoid.
let c!: LogswapClient;
let key!: PoolKey;
let deployment!: Record<string, string | number>;
let live = false;

try {
  deployment = JSON.parse(readFileSync(DEPLOY, "utf8"));
  const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
  await pub.getBlockNumber();
  c = createLogswapClient({
    public: pub,
    addresses: {
      cPoolManager: deployment.cPoolManager as Address,
      router: deployment.router as Address,
      lens: deployment.lens as Address,
      permit2: deployment.permit2 as Address,
      fPoolManager: deployment.fPoolManager as Address,
    },
  });
  key = {
    base: deployment.weth as Address,
    quote: deployment.usdc as Address,
    tickSpacing: BigInt(deployment.tickSpacing as number),
    phiMin: 0n,
    kappa: 0n,
    alpha: 0n,
  };
  live = true;
} catch {
  live = false;
}

if (!live && process.env.LOGSWAP_REQUIRE_NODE === "1") {
  throw new Error(`LOGSWAP_REQUIRE_NODE=1 but no node/deployment at ${RPC} / ${DEPLOY}`);
}

describe.skipIf(!live)("reads against the local deployment", () => {
  it("the manager is the version this SDK was generated against", async () => {
    await expect(assertVersion(c)).resolves.toBeUndefined();
  });

  it("discovers the seeded market from Initialize logs alone", async () => {
    const markets = await discoverMarkets(c);
    expect(markets.length).toBeGreaterThan(0);

    // the whole point: the key is reconstructed from the log, and its hash matches the deployment's
    const m = markets.find((x) => x.poolId === deployment.poolId);
    expect(m, "seeded market not found among Initialize logs").toBeDefined();
    expect(m!.key.base.toLowerCase()).toBe((deployment.weth as string).toLowerCase());
    expect(m!.key.quote.toLowerCase()).toBe((deployment.usdc as string).toLowerCase());
    // Compared exactly, now that the deploy script writes 256-bit values as STRINGS. It used to
    // emit JSON numbers, which JS parses as float64 — x0 = 8006367567650246000 (> 2^53) rounded to
    // ...245632 for every JS consumer. This assertion is what caught it, so keep it strict.
    expect(m!.x0).toBe(BigInt(deployment.x0 as string));
  });

  it("the offline poolId matches the one the deployer recorded", async () => {
    const markets = await discoverMarkets(c);
    const m = markets.find((x) => x.poolId === deployment.poolId)!;
    expect(poolId(m.key)).toBe(deployment.poolId);
  });

  it("reads pool state and derives price and the LP edge", async () => {
    const markets = await discoverMarkets(c);
    const m = markets.find((x) => x.poolId === deployment.poolId)!;
    const s = await getPool(c, m.key);

    expect(s.initialized).toBe(true);
    expect(s.backstopSeeded).toBe(true);
    expect(s.lActive).toBeGreaterThan(0n);
    expect(priceOf(s)).toBeGreaterThan(1000); // seeded at p = 3000
    expect(priceOf(s)).toBeLessThan(10000);

    // F - Sigma/2 is signed and defined even on a barely-traded pool
    expect(typeof lpEdge(s)).toBe("bigint");
    expect(await phiEff(c, m.key)).toBeGreaterThan(0n);
  });

  it("reads the ladder and validates floors against the grid", async () => {
    const markets = await discoverMarkets(c);
    const m = markets.find((x) => x.poolId === deployment.poolId)!;

    expect((await liveFloors(c, m.key)).length).toBeGreaterThan(0);
    expect(await isValidFloor(c, m.key, m.key.tickSpacing * 30n)).toBe(true);
    expect(await isValidFloor(c, m.key, m.key.tickSpacing * 30n + 1n)).toBe(false);
  });

  it("resolves a holder position with an id computed OFFLINE", async () => {
    const markets = await discoverMarkets(c);
    const m = markets.find((x) => x.poolId === deployment.poolId)!;
    // an UNCAPPED class the deployer holds: the lowest live tick may belong to a capped class
    // alone (the fixture's capped-out class sits lowest), and an offline id is uncapped by shape
    const held = await positionsOf(c, m.key, deployment.deployer as Address);
    expect(held.length).toBeGreaterThan(0);
    const floor = held[0]!.floor; // already log-price WAD; do NOT multiply by tickSpacing
    const floors = await liveFloors(c, m.key);
    expect(floors).toContain(floor);

    const p = await getHolderPosition(c, m.key, deployment.deployer as Address, floor);
    expect(p.floor).toBe(floor);
    expect(p.capped).toBe(false);
    expect(isPosition(p.id)).toBe(true);

    // and the chain agrees the offline id names that class
    // pass tickSpacing so the wrapper converts the lens's tick INDICES into log-price floors
    const d = await describeId(c, p.id, m.key.tickSpacing);
    expect(d.poolId).toBe(m.poolId);
    expect(d.floor).toBe(floor);
    expect(d.kFloor).toBe(floor / m.key.tickSpacing);
    expect(d.capped).toBe(false);
  });

  it("a token-claim id is not mistaken for a position", async () => {
    const cid = claimId(deployment.usdc as Address);
    expect(isPosition(cid)).toBe(false);
    // it is a valid 6909 id the manager will answer for, and it is NOT an LP position
    expect(await balanceOf(c, deployment.deployer as Address, cid)).toBeGreaterThanOrEqual(0n);

    const markets = await discoverMarkets(c);
    const m = markets.find((x) => x.poolId === deployment.poolId)!;
    const floors = await liveFloors(c, m.key);
    const pid = (await getHolderPosition(c, m.key, deployment.deployer as Address, floors[0]!)).id;

    const split = partitionIds([cid, pid]);
    expect(split.claims).toEqual([cid]);
    expect(split.positions).toEqual([pid]);
  });

  it("NO_CAP round-trips through an uncapped position id", async () => {
    const markets = await discoverMarkets(c);
    const m = markets.find((x) => x.poolId === deployment.poolId)!;
    const floors = await liveFloors(c, m.key);
    const p = await getHolderPosition(c, m.key, deployment.deployer as Address, floors[0]!, NO_CAP);
    expect(p.cap).toBe(NO_CAP);
  });
});
