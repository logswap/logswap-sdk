/**
 * client.ts — the SDK handle: addresses + viem clients.
 *
 * Construct once and pass to every helper. `wallet` is optional: read helpers need only `public`.
 *
 * **Three addresses, permanently.** Not three per market — every market lives in the one manager,
 * and a market is an `initialize(key, x0)` call rather than a deployment. So this is a constant of
 * the protocol, not configuration that grows.
 */

import type { Address, PublicClient, WalletClient } from "viem";

export interface LogswapAddresses {
  /** The C singleton — a floor per position, on a tick ladder. ERC-6909 positions and token
   *  claims live here. */
  cPoolManager: Address;
  /** User entry for every market: multicall, blended mint, zap, routes, Permit2. */
  router: Address;
  /** Read-only: ladder derivations and revert-quoter previews. */
  lens: Address;
  /**
   * The F-pool singleton — fungible claims, one shared floor, n bases. Optional only because a
   * deployment predating it will not carry the address; every F-pool call needs it.
   */
  fPoolManager?: Address;
  /** Optional — the router falls back to plain approvals when absent. */
  permit2?: Address;
}

export interface LogswapClient {
  public: PublicClient;
  wallet?: WalletClient;
  addresses: LogswapAddresses;
}

export function createLogswapClient(args: {
  public: PublicClient;
  wallet?: WalletClient;
  addresses: LogswapAddresses;
}): LogswapClient {
  return { public: args.public, wallet: args.wallet, addresses: args.addresses };
}

/**
 * Assert the deployment matches the ABI this build was generated against.
 *
 * Cheap insurance worth taking at construction: without it, a manager from a different deployment
 * decodes into plausible-looking garbage rather than failing. `version` is bumped on any tier-1 or
 * tier-2 change (docs/app.md).
 *
 * **2** since 2026-09-01. It sat at 1 across a read surface that changed underneath it — the nine
 * `public constant` getters left the manager for `CParams`, `move` gained its settlement bounds,
 * `createMarket` arrived — so a 1 answered for two incompatible ABIs and this check passed against
 * a manager it should have rejected. Observed, not theorised: a local chain running a pre-trim
 * manager sailed through `assertVersion` while `FEE_MAX()` still answered on it. Move this in the
 * same change as `CParams.VERSION`, never after it.
 *
 * **3** since 2026-09-03 (contracts `d8406fb`): `burnById` and `update` take an `owner`, `update`
 * mints to `to`, `positions()` returns `aps` as uint128 — and a returned quote flow now carries the
 * swept fees (decisions 018), which is why `exit`'s settle-to-one-asset math changed with it.
 *
 * **4** since 2026-09-18 (decisions 042 + 040): `PoolKey` is `(base, quote, tickSpacing, phi)` —
 * the variance kernel and its two key fields are gone, so every pool id changed; `phiEff` is
 * `phiOf`; `getPool` lost `sigma2Ema`; `Initialize` lost two fields; the cut is
 * `MINT_FEE_PROTOCOL_CUT` / `setFeeParams`.
 */
export const EXPECTED_VERSION = 4n;
/**
 * The F manager's own tag (contracts 25a7bcf: 5 — the key's salt, pool names, the sponsor registry;
 * 4 was the income-only harvest cut).
 *
 * A FLOOR, not an equality — unlike `EXPECTED_VERSION` above. The F primitive is iterating fast and
 * its bumps are mostly additive (6 is `multicall`, which nothing this SDK calls goes near), so an
 * exact match meant each one bricked every app on the deployment until the SDK was republished — a
 * version wall in front of a change that broke nothing. The cost is that a genuinely breaking bump
 * passes it; when one lands, raise this constant in the same change, which is the discipline
 * `EXPECTED_VERSION` enforces mechanically and this one asks for.
 */
// 7 (2026-09-15): the reserves are the state and the marks derived, `lockStrike`, the dividend
// harvest, the relaunch (`dissolve(poolId, successor)`, `rollIn`), the reserve-named seed, the
// sponsor facet — decisions 025–031.
// 8 (2026-09-15): the relaunch is in place (decisions 032) — every share id carries the
// generation (`fPoolShareId(poolId, gen)`), `dissolve(poolId)`, `redeem`, `claim` / `dividendOf`
// / `rollIn` / `previewRollIn` take the generation, `Pool.gen` replaces `dissolved` and
// `successor`. A 7 deployment's share ids do not even resolve with this SDK.
// 9 (2026-09-16): `deepen` is gone, `Pool.leverTheta` is `harvestedTheta` (decisions 034).
// 10 (2026-09-17): no floor guard — `Pool.minBuffer`, `raiseMinBuffer`, `LEVER_FLOOR` gone;
// `dissolve` needs an empty bid on every pool (decisions 035); the key bit is the CLASS, `pad`
// (036): `seed` mints a pad's shares to 0xdead, and the operator, the gates and the list are
// refused on it — `fPoolLaunch` no longer transfers the seed itself.
// 11 (2026-09-17): roles and entries (decisions 037) — the operator runs the pool (`harvest`,
// `dissolve`, `setLegs`) and is the authority until appointed, two-step (`acceptOperator`,
// `Pool.pendingOperator`); `setLegL`/`admitLeg` are gone, `setLegs` edits the next generation's
// table while unseeded; `fPoolRelaunch` takes `legs`.
// `getPool` decodes one field fewer, so a 9 deployment's struct no longer matches this SDK.
// 12 (2026-09-17): one contract (decisions 039) — the sponsor facet is folded back into the
// manager; `sponsor()` and the fallback are gone, every entry, error and event unchanged, so
// `fPoolManagerAbi` is the manager's own ABI and no longer a union. Layout unchanged.
// 13 (2026-09-18): one vocabulary (decisions 040) — `HARVEST_FEE` is `HARVEST_PROTOCOL_CUT` (a
// cut of harvested income, not a fee on the harvest) and the exemption is `harvestCutExempt` /
// `setHarvestCutExempt`; `acceptAuthority` clears the operator, pending and accepted (a mandate
// is voided by the handover of the role that granted it); `setLegs` needs a generation to have
// lived (`gen > 0`); `initialize` refuses a codeless base and `mint` refuses `to = address(0)`
// on both managers. Layout unchanged.
export const EXPECTED_F_VERSION = 13n;

export async function assertVersion(c: LogswapClient, expected = EXPECTED_VERSION): Promise<void> {
  const { cPoolManagerAbi } = await import("./generated.js");
  const got = await c.public.readContract({
    address: c.addresses.cPoolManager,
    abi: cPoolManagerAbi,
    functionName: "version",
  });
  if (got !== expected) {
    throw new Error(
      `logswap: manager at ${c.addresses.cPoolManager} reports version ${got}, but this SDK was built ` +
        `against version ${expected}. Upgrade the SDK or point at the matching deployment.`,
    );
  }
  // the F manager carries its own tag since contracts c782811; assert it the same way when deployed
  if (c.addresses.fPoolManager) {
    const { fPoolManagerAbi } = await import("./generated.js");
    const gotF = await c.public.readContract({
      address: c.addresses.fPoolManager,
      abi: fPoolManagerAbi,
      functionName: "version",
    });
    if (gotF < EXPECTED_F_VERSION) {
      throw new Error(
        `logswap: F manager at ${c.addresses.fPoolManager} reports version ${gotF}, but this SDK needs ` +
          `at least F version ${EXPECTED_F_VERSION}. Upgrade the deployment or point at a newer one.`,
      );
    }
  }
}
