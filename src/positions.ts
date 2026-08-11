/**
 * positions.ts — position and fee reads.
 *
 * A position CLASS is fungible at its full key: uncapped by (pool, floor), capped by
 * (pool, floor, cap). Holders own ERC-6909 shares of a class; fees are tracked per holder, so two
 * accounts holding the same class can have different claimable amounts.
 */

import type { Address } from "viem";
import { logswapLensAbi, logswapManagerAbi } from "./generated.js";
import type { LogswapClient } from "./client.js";
import { poolId, type PoolKey } from "./keys.js";
import { isPosition, NO_CAP, positionId, unpackFloorCap } from "./ids.js";

/** A class's aggregate state — the whole class, not one holder's slice. */
export interface PositionClass {
  /** Total exposure across every holder. */
  L: bigint;
  /** Total shares outstanding. */
  shares: bigint;
  /** Fee-per-share accumulator (masterchef-style). */
  aps: bigint;
  /** Snapshot of `F_above[floor] − F_above[cap]` at the class's last touch. */
  insideLast: bigint;
}

export async function getPositionClass(c: LogswapClient, id: bigint): Promise<PositionClass> {
  const r = (await c.public.readContract({
    address: c.addresses.manager,
    abi: logswapManagerAbi,
    functionName: "positions",
    args: [id],
  })) as readonly [bigint, bigint, bigint, bigint];
  return { L: r[0], shares: r[1], aps: r[2], insideLast: r[3] };
}

/** A holder's share balance in a class. */
export async function balanceOf(c: LogswapClient, owner: Address, id: bigint): Promise<bigint> {
  return c.public.readContract({
    address: c.addresses.manager,
    abi: logswapManagerAbi,
    functionName: "balanceOf",
    args: [owner, id],
  }) as Promise<bigint>;
}

/**
 * A holder's claimable fees, in quote.
 *
 * For a capped class this is credit-minus-debit — two accumulator reads, `F_above[floor]` less
 * `F_above[cap]` — which is monotone non-decreasing, so a capped position can never owe fees.
 */
export async function feesOf(c: LogswapClient, id: bigint, owner: Address): Promise<bigint> {
  return c.public.readContract({
    address: c.addresses.lens,
    abi: logswapLensAbi,
    functionName: "feesOfById",
    args: [id, owner],
  }) as Promise<bigint>;
}

/** A holder's full view of one class: what they own and what they can claim. */
export interface HolderPosition {
  id: bigint;
  key: PoolKey;
  floor: bigint;
  cap: bigint;
  capped: boolean;
  shares: bigint;
  /** The holder's pro-rata slice of the class's exposure. */
  L: bigint;
  claimableFees: bigint;
}

/**
 * Everything a UI needs for one holder in one class. Computes the id offline, so this costs three
 * reads and no id lookup.
 */
export async function getHolderPosition(
  c: LogswapClient,
  key: PoolKey,
  owner: Address,
  floor: bigint,
  cap: bigint = NO_CAP,
): Promise<HolderPosition> {
  const id = positionId(poolId(key), key.tickSpacing, floor, cap);
  const [cls, shares, claimableFees] = await Promise.all([
    getPositionClass(c, id),
    balanceOf(c, owner, id),
    feesOf(c, id, owner),
  ]);
  return {
    id,
    key,
    floor,
    cap,
    capped: cap !== NO_CAP,
    shares,
    L: cls.shares === 0n ? 0n : (cls.L * shares) / cls.shares,
    claimableFees,
  };
}

/**
 * Resolve an id the manager already knows back to its (pool, floor, cap).
 *
 * The inverse direction — id to class — needs the registry, because the id is a HASH: it cannot be
 * unpacked offline the way `positionId` can be computed offline. `IdRegistered` carries the same
 * information in the clear, so an indexer never needs this call.
 *
 * **Units.** The lens is inconsistent here and this wrapper hides it: `unpack` returns tick
 * INDICES (`kFloor`, `kCap`), while `liveFloors` returns log-price floors. Pass `tickSpacing` and
 * you get `floor`/`cap` in log-price WAD, the same units `mint` takes; omit it and you get the raw
 * indices, honestly named.
 */
export async function describeId(
  c: LogswapClient,
  id: bigint,
  tickSpacing?: bigint,
): Promise<{
  poolId: `0x${string}`;
  kFloor: bigint;
  kCap: bigint;
  capped: boolean;
  floor?: bigint;
  cap?: bigint;
}> {
  const r = (await c.public.readContract({
    address: c.addresses.lens,
    abi: logswapLensAbi,
    functionName: "unpack",
    args: [id],
  })) as readonly [`0x${string}`, bigint, bigint, boolean];
  const out = { poolId: r[0], kFloor: r[1], kCap: r[2], capped: r[3] };
  if (tickSpacing === undefined) return out;
  return {
    ...out,
    floor: r[1] * tickSpacing,
    cap: r[3] ? r[2] * tickSpacing : NO_CAP,
  };
}

/**
 * Split ERC-6909 ids into positions and token claims.
 *
 * **Do this before treating any `Transfer` as an LP event.** Bit 255 clear means a token claim — a
 * bearer IOU a market maker uses to park inventory inside the manager — not a position. An indexer
 * that skips this reports phantom LP positions for every parked balance.
 */
export function partitionIds(ids: readonly bigint[]): { positions: bigint[]; claims: bigint[] } {
  const positions: bigint[] = [];
  const claims: bigint[] = [];
  for (const id of ids) (isPosition(id) ? positions : claims).push(id);
  return { positions, claims };
}

/** Decode a class's floor and cap from its packed field (as carried by `IdRegistered`). */
export function describePacked(tickSpacing: bigint, packed: bigint) {
  return unpackFloorCap(tickSpacing, packed);
}
