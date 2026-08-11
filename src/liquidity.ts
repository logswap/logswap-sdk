/**
 * liquidity.ts — providing, editing and exiting.
 *
 * The position primitive is richer than a v3 range, and the helpers below name the operations
 * rather than making callers assemble them:
 *
 *   mint      open or add to a class at a floor (and optionally a cap)
 *   zapIn     fund a mint from ONE asset — the router swaps the imbalanced part through the curve
 *   update    resize and reposition in one call; `newL = 0` exits
 *   move      reposition at constant exposure
 *   harvest   raise the floor to withdraw PURE QUOTE, leaving the base leg untouched
 *   burn      exit, in kind, fees swept along
 */

import type { Hash } from "viem";
import { logswapRouterAbi } from "./generated.js";
import type { LogswapClient } from "./client.js";
import { poolId, type PoolKey } from "./keys.js";
import { NO_CAP, positionId } from "./ids.js";
import { resolveDeadline, resolveRecipient, sendRouterWrite, type WriteOptions } from "./write.js";

export interface MintArgs extends WriteOptions {
  key: PoolKey;
  /** Log-price floor. Need not be on the grid — see the blending note below. */
  targetFloor: bigint;
  cap?: bigint;
  /** Exposure to add. */
  L: bigint;
  maxBaseIn?: bigint;
  maxQuoteIn?: bigint;
}

/**
 * Mint at `targetFloor`, blending across the two adjacent rungs when it is off-grid.
 *
 * This is why the floor ladder can be coarse without the UX being coarse: a blend of two adjacent
 * classes IS exactly one position at the weighted-mean floor, so a continuous floor slider works
 * over a discrete ladder. The router settles once per token, not once per rung.
 *
 * **A mint at floor == spot costs zero quote** ($Q(\xi) = 0$), and one above spot is dormant and
 * costs zero quote too — that is what makes single-asset entry possible in both directions.
 */
export async function mint(c: LogswapClient, a: MintArgs): Promise<Hash> {
  const MAX = (1n << 256n) - 1n;
  return sendRouterWrite(c, {
    abi: logswapRouterAbi,
    functionName: "mintBlended",
    args: [
      a.key,
      a.targetFloor,
      a.cap ?? NO_CAP,
      a.L,
      a.maxBaseIn ?? MAX,
      a.maxQuoteIn ?? MAX,
      resolveRecipient(c, a),
      resolveDeadline(a),
    ],
  });
}

export interface ZapArgs extends WriteOptions {
  key: PoolKey;
  /** Fund entirely from base (true) or entirely from quote (false). */
  fundWithBase: boolean;
  amountIn: bigint;
  targetFloor: bigint;
  cap?: bigint;
  L: bigint;
  maxIn?: bigint;
}

/**
 * Fund a mint from a single asset: the router swaps the imbalanced part through the curve, then
 * mints, all inside one lock.
 *
 * Routing the imbalanced part through the CURVE is the point, not an implementation detail. A
 * pro-rata deposit of one asset would be a zero-slippage, zero-fee swap at stale spot — a subsidy
 * paid by the incumbent LPs (`logswap-docs` §*Quote-only capital*). Paying the curve removes it.
 */
export async function zapIn(c: LogswapClient, a: ZapArgs): Promise<Hash> {
  return sendRouterWrite(c, {
    abi: logswapRouterAbi,
    functionName: "zapIn",
    args: [
      a.key,
      a.fundWithBase,
      a.amountIn,
      a.targetFloor,
      a.cap ?? NO_CAP,
      a.L,
      a.maxIn ?? (1n << 256n) - 1n,
      resolveRecipient(c, a),
      resolveDeadline(a),
    ],
  });
}

export interface UpdateArgs extends WriteOptions {
  key: PoolKey;
  fromId: bigint;
  shares: bigint;
  toFloor: bigint;
  toCap?: bigint;
  /** New exposure. `0n` exits the position entirely. */
  newL: bigint;
  maxBaseIn?: bigint;
  maxQuoteIn?: bigint;
}

/** Resize and reposition in one call — the edit v3 cannot express without destroying the position. */
export async function update(c: LogswapClient, a: UpdateArgs): Promise<Hash> {
  const MAX = (1n << 256n) - 1n;
  return sendRouterWrite(c, {
    abi: logswapRouterAbi,
    functionName: "update",
    args: [
      a.key,
      a.fromId,
      a.shares,
      a.toFloor,
      a.toCap ?? NO_CAP,
      a.newL,
      a.maxBaseIn ?? MAX,
      a.maxQuoteIn ?? MAX,
      resolveRecipient(c, a),
      resolveDeadline(a),
    ],
  });
}

export interface MoveArgs extends WriteOptions {
  key: PoolKey;
  fromId: bigint;
  shares: bigint;
  toFloor: bigint;
  toCap?: bigint;
}

/** Reposition at constant exposure. */
export async function move(c: LogswapClient, a: MoveArgs): Promise<Hash> {
  return sendRouterWrite(c, {
    abi: logswapRouterAbi,
    functionName: "move",
    args: [a.key, a.fromId, a.shares, a.toFloor, a.toCap ?? NO_CAP, resolveDeadline(a)],
  });
}

export interface HarvestArgs extends WriteOptions {
  key: PoolKey;
  /** The position's current floor. */
  fromFloor: bigint;
  /** The new, HIGHER floor. Must be below spot. */
  toFloor: bigint;
  shares: bigint;
  cap?: bigint;
}

/**
 * Withdraw proceeds as PURE QUOTE by raising the floor — without touching the base leg.
 *
 * A burn is in kind: it returns base and quote pro rata, so taking α of the proceeds also takes α
 * of the unsold inventory off the market. Raising the floor instead releases
 *
 *   ΔQ = L (ξ' − ξ),   ΔR = 0
 *
 * because $R = Le^{-x}$ depends on neither the floor nor the withdrawal. No base moves, the price
 * does not move, and depth is unchanged. Measured on a live pool: `dBase` exactly 0, price and
 * `lActive` unchanged (`logswap-docs` launchpad §5).
 *
 * **The cost, which a UI must show:** the position stops bidding below `toFloor`. Restoring the
 * original floor later re-deploys the quote and re-arms that bid, so the lever runs both ways.
 *
 * The mint fee does not bite — `update` charges only on a net EARNING increase, and exposure is
 * unchanged.
 */
export async function harvest(c: LogswapClient, a: HarvestArgs): Promise<Hash> {
  if (a.toFloor <= a.fromFloor) {
    throw new Error(
      `logswap: harvest raises the floor — toFloor (${a.toFloor}) must exceed fromFloor (${a.fromFloor}). ` +
        `To deepen the bid instead, use move() and expect to PAY quote.`,
    );
  }
  const fromId = positionId(poolId(a.key), a.key.tickSpacing, a.fromFloor, a.cap ?? NO_CAP);
  return move(c, {
    key: a.key,
    fromId,
    shares: a.shares,
    toFloor: a.toFloor,
    toCap: a.cap,
    deadline: a.deadline,
  });
}

/** Quote released by a harvest, exactly: ΔQ = L(ξ' − ξ). Base is untouched. */
export function harvestProceeds(L: bigint, fromFloor: bigint, toFloor: bigint): bigint {
  if (toFloor <= fromFloor) return 0n;
  return (L * (toFloor - fromFloor)) / 10n ** 18n;
}

export interface BurnArgs extends WriteOptions {
  key: PoolKey;
  ids: readonly bigint[];
  shares: readonly bigint[];
  minBaseOut?: bigint;
  minQuoteOut?: bigint;
}

/**
 * Exit, in kind. Accrued fees are swept into the same settlement — no separate claim.
 *
 * In kind means both legs, pro rata. If the intent is to take proceeds while leaving inventory in
 * the market, that is {@link harvest}, not this.
 */
export async function burn(c: LogswapClient, a: BurnArgs): Promise<Hash> {
  if (a.ids.length !== a.shares.length) throw new Error("logswap: ids and shares length mismatch");
  return sendRouterWrite(c, {
    abi: logswapRouterAbi,
    functionName: "burn",
    args: [
      a.key,
      a.ids,
      a.shares,
      a.minBaseOut ?? 0n,
      a.minQuoteOut ?? 0n,
      resolveRecipient(c, a),
      resolveDeadline(a),
    ],
  });
}
