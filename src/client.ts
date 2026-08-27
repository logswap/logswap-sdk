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
 */
export const EXPECTED_VERSION = 1n;

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
}
