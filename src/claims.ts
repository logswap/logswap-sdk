/**
 * claims.ts — fee claims, and the ERC-6909 operator grant every router write depends on.
 *
 * Note the two unrelated meanings of "claim" in this protocol, kept apart here:
 *   - a FEE claim   — `claimFees`, withdrawing accrued quote while the position stays whole
 *   - a TOKEN claim — a bearer IOU (bit-255-clear id) for inventory parked inside the manager
 */

import type { Address, Hash } from "viem";
import { logswapManagerAbi, logswapRouterAbi } from "./generated.js";
import type { LogswapClient } from "./client.js";
import type { PoolKey } from "./keys.js";
import { isPosition } from "./ids.js";
import { requireWallet, resolveDeadline, resolveRecipient, sendRouterWrite, type WriteOptions } from "./write.js";

export interface ClaimFeesArgs extends WriteOptions {
  key: PoolKey;
  ids: readonly bigint[];
}

/**
 * Claim accrued fees across one or more classes: one transfer, positions untouched.
 *
 * **Every id must be REGISTERED** — one the manager has seen minted. An id for a class that has
 * never existed reverts the whole batch with `WrongPool`, because an unregistered id has
 * `poolId == 0` and cannot be shown to belong to this pool. In a contract holding every market's
 * assets, "cannot be shown to belong" must not be read as "belongs". A class that exists but which
 * the caller does not hold is fine — that is a no-op, not a revert.
 */
export async function claimFees(c: LogswapClient, a: ClaimFeesArgs): Promise<Hash> {
  for (const id of a.ids) {
    if (!isPosition(id)) {
      throw new Error(
        `logswap: id ${id} is a TOKEN claim (bit 255 clear), not a position — it has no fees to claim.`,
      );
    }
  }
  return sendRouterWrite(c, {
    abi: logswapRouterAbi,
    functionName: "claim",
    args: [a.key, a.ids, resolveRecipient(c, a), resolveDeadline(a)],
  });
}

/**
 * Grant the router operator rights over your ERC-6909 positions.
 *
 * **Required before any burn, update, move or harvest** — those pull the shares to the router
 * first. Without it they revert on the transfer, which reads as an unrelated balance error. Swaps
 * and mints do not need it.
 *
 * One grant covers every market, because the positions all live in the one manager.
 */
export async function approveRouterAsOperator(c: LogswapClient, approved = true): Promise<Hash> {
  const { account } = requireWallet(c);
  return c.wallet!.writeContract({
    address: c.addresses.manager,
    abi: logswapManagerAbi,
    functionName: "setOperator",
    args: [c.addresses.router, approved],
    account,
    chain: c.wallet!.chain,
  } as never);
}

/** Is the router already an operator for `owner`? Check before prompting for a signature. */
export async function isRouterApproved(c: LogswapClient, owner: Address): Promise<boolean> {
  return c.public.readContract({
    address: c.addresses.manager,
    abi: logswapManagerAbi,
    functionName: "isOperator",
    args: [owner, c.addresses.router],
  }) as Promise<boolean>;
}

/**
 * What a wallet still has to approve before a given action.
 *
 * Surfacing this up front is the difference between one prompt and a failed transaction: the ERC-20
 * allowances and the 6909 operator grant are separate approvals with separate failure modes.
 */
export interface Readiness {
  needsOperator: boolean;
  needsBaseAllowance: boolean;
  needsQuoteAllowance: boolean;
}

export async function checkReadiness(
  c: LogswapClient,
  key: PoolKey,
  owner: Address,
  need: { base?: bigint; quote?: bigint; positions?: boolean } = {},
): Promise<Readiness> {
  const erc20 = [
    {
      type: "function",
      name: "allowance",
      stateMutability: "view",
      inputs: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
      ],
      outputs: [{ type: "uint256" }],
    },
  ] as const;

  const [operator, baseAllow, quoteAllow] = await Promise.all([
    need.positions ? isRouterApproved(c, owner) : Promise.resolve(true),
    need.base
      ? (c.public.readContract({
          address: key.base,
          abi: erc20,
          functionName: "allowance",
          args: [owner, c.addresses.router],
        }) as Promise<bigint>)
      : Promise.resolve(0n),
    need.quote
      ? (c.public.readContract({
          address: key.quote,
          abi: erc20,
          functionName: "allowance",
          args: [owner, c.addresses.router],
        }) as Promise<bigint>)
      : Promise.resolve(0n),
  ]);

  return {
    needsOperator: !operator,
    needsBaseAllowance: need.base !== undefined && baseAllow < need.base,
    needsQuoteAllowance: need.quote !== undefined && quoteAllow < need.quote,
  };
}
