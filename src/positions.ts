/**
 * positions.ts — position and fee reads.
 *
 * A position CLASS is fungible at its full key: uncapped by (pool, floor), capped by
 * (pool, floor, cap). Holders own ERC-6909 shares of a class; fees are tracked per holder, so two
 * accounts holding the same class can have different claimable amounts.
 */

import { parseAbiItem } from "viem";
import type { Address } from "viem";
import { logswapLensAbi, cPoolManagerAbi } from "./generated.js";
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
    address: c.addresses.cPoolManager,
    abi: cPoolManagerAbi,
    functionName: "positions",
    args: [id],
  })) as readonly [bigint, bigint, bigint, bigint];
  return { L: r[0], shares: r[1], aps: r[2], insideLast: r[3] };
}

/** A holder's share balance in a class. */
export async function balanceOf(c: LogswapClient, owner: Address, id: bigint): Promise<bigint> {
  return c.public.readContract({
    address: c.addresses.cPoolManager,
    abi: cPoolManagerAbi,
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

/**
 * The QUOTE leg of a position at log-price `x`, in quote units.
 *
 * Mirrors the manager's `_assets` exactly, in its three cases:
 *
 * - **floor above spot** — the position is all base and holds no quote at all.
 * - **in range** — `L·(x − ξ)`: the buffer built up as price rose from the floor.
 * - **capped out** (spot at or above the cap) — `L·(cap − ξ)`, frozen. Past its cap a position
 *   stops converting, which is what makes a capped position a resting limit order.
 *
 * Exact: this is bigint arithmetic throughout, unlike the base leg, which needs `L/p` and is
 * therefore transcendental. If you need base, read it from the chain rather than approximating it
 * here — a display-only float has no business being subtracted from a balance.
 */
export function positionQuote(
  p: { L: bigint; floor: bigint; cap: bigint; capped: boolean },
  x: bigint,
): bigint {
  if (p.floor > x) return 0n;
  const upper = p.capped && p.cap <= x ? p.cap : x;
  return (p.L * (upper - p.floor)) / 10n ** 18n;
}

/**
 * Every UNCAPPED position `owner` holds in a market, enumerated fully on-chain by the lens — a
 * bitmap walk plus a balance check per live floor. No indexer, no log scan. Capped classes are
 * not listed here by contract (their candidate set is quadratic in live ticks); they come from
 * `IdRegistered` replay when an indexer exists.
 */
export interface HeldPositionRow {
  id: bigint;
  floor: bigint;
  /** NO_CAP for an uncapped class. */
  cap: bigint;
  capped: boolean;
  shares: bigint;
  /** The holder's slice of the class's exposure. */
  L: bigint;
  /** Claimable now, quote units. */
  fees: bigint;
}

export async function positionsOf(c: LogswapClient, key: PoolKey, owner: Address): Promise<HeldPositionRow[]> {
  const rows = (await c.public.readContract({
    address: c.addresses.lens,
    abi: logswapLensAbi,
    functionName: "positionsOf",
    args: [key, owner],
  } as never)) as readonly { id: bigint; floor: bigint; shares: bigint; L: bigint; fees: bigint }[];
  return rows.map((r) => ({ id: r.id, floor: r.floor, cap: NO_CAP, capped: false, shares: r.shares, L: r.L, fees: r.fees }));
}

const ID_REGISTERED = parseAbiItem("event IdRegistered(uint256 indexed id, bytes32 indexed poolId, int256 floor, int256 cap, bool capped)");

/**
 * EVERY class this owner holds in a pool, capped ones included — the complete book.
 *
 * `positionsOf` (the lens) enumerates the uncapped book from the ladder bitmap in one call and
 * cannot list capped classes: a capped id is a (floor, cap) pair, quadratic in live ticks. This
 * replays `IdRegistered` — every class is registered once, on first mint, with its floor and
 * cap — then checks the owner's ERC-6909 balance on each and reads the class for its L, so the
 * holder's slice is L · shares_owner / shares_class, and fees from the lens. One log query plus
 * a read per registered class; fine for a pool's lifetime of classes.
 */
export async function holdingsOf(c: LogswapClient, key: PoolKey, owner: Address, fromBlock: bigint = 0n): Promise<HeldPositionRow[]> {
  const pool = poolId(key);
  const logs = await c.public.getLogs({ address: c.addresses.cPoolManager, event: ID_REGISTERED, args: { poolId: pool }, fromBlock, toBlock: "latest" });
  const { logswapLensAbi } = await import("./generated.js");
  const rows = await Promise.all(
    logs.map(async (l) => {
      const a = l.args as { id?: bigint; floor?: bigint; cap?: bigint; capped?: boolean };
      const id = a.id ?? 0n;
      const bal = (await c.public.readContract({ address: c.addresses.cPoolManager, abi: cPoolManagerAbi, functionName: "balanceOf", args: [owner, id] } as never)) as bigint;
      if (bal === 0n) return null;
      const [L, shares] = (await c.public.readContract({ address: c.addresses.cPoolManager, abi: cPoolManagerAbi, functionName: "positions", args: [id] } as never)) as readonly [bigint, bigint, bigint, bigint];
      const fees = (await c.public.readContract({ address: c.addresses.lens, abi: logswapLensAbi, functionName: "feesOfById", args: [id, owner] } as never).catch(() => 0n)) as bigint;
      const mine = shares > 0n ? (L * bal) / shares : 0n;
      return { id, floor: a.floor ?? 0n, cap: a.capped ? (a.cap ?? NO_CAP) : NO_CAP, capped: !!a.capped, shares: bal, L: mine, fees } as HeldPositionRow;
    }),
  );
  return rows.filter((r): r is HeldPositionRow => r !== null);
}
