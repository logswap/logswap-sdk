/**
 * liquidity.ts — providing, editing and exiting a C position.
 *
 * A class is (ξ, μ, L): floor, cap, exposure. One primitive sets all three — `update` — and every
 * edit is a constraint on it. The vocabulary follows the geometry (decisions 009): **the verb
 * names the axis, the direction is a signed rung count**, and only two direction-words survive,
 * because each names a wallet flow the user must see.
 *
 *   update(ξ', μ', L')     the primitive
 *   ├─ move(ξ', μ')        L pinned
 *   │   ├─ floor(±n)       μ pinned  · ↑ harvest (receive quote) · ↓ deepen (pay quote)
 *   │   ├─ cap(±n)         ξ pinned  · no direction words
 *   │   └─ shift(±n)       width pinned — the translation
 *   ├─ resize(L')          ξ, μ pinned; L' = 0 is the exit
 *   └─ reprice(ξ')         R pinned: L' = L·e^{ξ' − ξ}, dormant only
 *   mint · burn · claim
 *
 * Every edit is ONE action of the router's batch (decisions 010, `actions.ts`), which is what
 * lets it settle in kind, or in base, or in quote: `settleIn` appends the one swap that nets the
 * other side, and the batch moves a single token. `previewEdit` is the lens's `previewUpdate` —
 * the exact flows, mint fee and swept fees included — and is what an editor shows before its one
 * apply.
 */

import type { Address, Hash } from "viem";
import { logswapLensAbi, logswapRouterAbi } from "./generated.js";
import type { LogswapClient } from "./client.js";
import type { PoolKey } from "./keys.js";
import { NO_CAP } from "./ids.js";
import { describeId, getPositionClass } from "./positions.js";
import {
  execute,
  OPEN_DELTA,
  settleInKind,
  settleOnly,
  swapExactInAction,
  swapExactOutAction,
  updateAction,
  type Action,
  type PairBounds,
  type Settle,
} from "./actions.js";
import {
  requireWallet,
  resolveDeadline,
  resolveRecipient,
  sendRouterWrite,
  sendRouterWriteWithPermits,
  type WriteOptions,
} from "./write.js";

/* mint ====================================================================== */

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
  return sendRouterWriteWithPermits(c, {
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
  }, [a.key.base, a.key.quote]);
}

export interface CreateMarketArgs extends WriteOptions {
  key: PoolKey;
  /** Launch log-price. Bounded by the manager to ±46 (the price domain, decisions 012). */
  x0: bigint;
  /** The backstop's floor — the first mint's rung, permanent for the pool's life. */
  targetFloor: bigint;
  /** The founding exposure; must exceed the manager's `minBackstopL` lock. */
  L: bigint;
  maxBaseIn?: bigint;
  maxQuoteIn?: bigint;
}

/**
 * Create a market ATOMICALLY: `initialize` at `x0` plus the backstop-establishing first mint in
 * one transaction — the canonical creation path (decisions 013, security-review H-02). The
 * two-step path let an attacker seat the PERMANENT backstop at a hostile rung between an honest
 * `initialize` and its first mint; here either both land or neither, and a front-run of the whole
 * call reverts it without moving a wei. No cap: the first mint IS the backstop and must be
 * uncapped.
 */
export async function createMarket(c: LogswapClient, a: CreateMarketArgs): Promise<Hash> {
  const MAX = (1n << 256n) - 1n;
  return sendRouterWriteWithPermits(c, {
    abi: logswapRouterAbi,
    functionName: "createMarket",
    args: [
      a.key,
      a.x0,
      a.targetFloor,
      a.L,
      a.maxBaseIn ?? MAX,
      a.maxQuoteIn ?? MAX,
      resolveRecipient(c, a),
      resolveDeadline(a),
    ],
  }, [a.key.base, a.key.quote]);
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
 * mints, all inside one lock — the two-action batch `[swapExactIn, mint]`.
 *
 * Routing the imbalanced part through the CURVE is the point, not an implementation detail. A
 * pro-rata deposit of one asset would be a zero-slippage, zero-fee swap at stale spot — a subsidy
 * paid by the incumbent LPs (`logswap-docs` §*Quote-only capital*). Paying the curve removes it.
 */
export async function zapIn(c: LogswapClient, a: ZapArgs): Promise<Hash> {
  return sendRouterWriteWithPermits(c, {
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
  }, [a.fundWithBase ? a.key.base : a.key.quote]);
}

/* the primitive, and its named entry ======================================== */

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

/** The primitive, through the router's named entry: resize and reposition in one call, in kind. */
export async function update(c: LogswapClient, a: UpdateArgs): Promise<Hash> {
  const MAX = (1n << 256n) - 1n;
  return sendRouterWriteWithPermits(c, {
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
  }, [a.key.base, a.key.quote]);
}

export interface MoveArgs extends WriteOptions {
  key: PoolKey;
  fromId: bigint;
  shares: bigint;
  toFloor: bigint;
  toCap?: bigint;
  maxBaseIn?: bigint;
  maxQuoteIn?: bigint;
}

/**
 * Reposition at constant exposure — the L-pinned parent of `floor`, `cap` and `shift`; in kind.
 *
 * **Bound it.** The router used to settle this entry with no limit, which meant a reposition that
 * priced differently by inclusion time could pull the whole allowance (security-review2 M-01).
 * The defaults below are unbounded for callers who genuinely want that; pass `maxBaseIn` /
 * `maxQuoteIn` from a preview for anything user-facing.
 */
export async function move(c: LogswapClient, a: MoveArgs): Promise<Hash> {
  const MAX = (1n << 256n) - 1n;
  return sendRouterWrite(c, {
    abi: logswapRouterAbi,
    functionName: "move",
    args: [
      a.key,
      a.fromId,
      a.shares,
      a.toFloor,
      a.toCap ?? NO_CAP,
      a.maxBaseIn ?? MAX,
      a.maxQuoteIn ?? MAX,
      resolveRecipient(c, a),
      resolveDeadline(a),
    ],
  });
}

/* the edit tree ============================================================= */

/** Which token the edit settles in. `kind` moves both legs; `base` / `quote` nets the other side through the curve. */
export type SettleIn = "kind" | "base" | "quote";

export interface EditArgs extends WriteOptions, PairBounds {
  key: PoolKey;
  fromId: bigint;
  /** The shares to edit — all of a holding, or part of it. */
  shares: bigint;
  /** Default `kind`. */
  settleIn?: SettleIn;
}

export interface EditPreview {
  /** Signed, + = the caller deposits; the mint fee is inside `dQuote`. */
  dBase: bigint;
  dQuote: bigint;
  /** Accrued fees the edit sweeps, delivered in the same settlement. */
  fees: bigint;
}

/** The exact flows of an edit before it is sent — the lens's `previewUpdate`. */
export async function previewEdit(
  c: LogswapClient,
  a: { key: PoolKey; fromId: bigint; holder?: Address; shares: bigint; toFloor: bigint; toCap?: bigint; newL: bigint },
): Promise<EditPreview> {
  const holder = a.holder ?? requireWallet(c).address;
  const r = (await c.public.readContract({
    address: c.addresses.lens,
    abi: logswapLensAbi,
    functionName: "previewUpdate",
    args: [a.key, a.fromId, holder, a.shares, a.toFloor, a.toCap ?? NO_CAP, a.newL],
  })) as readonly [bigint, bigint, bigint];
  return { dBase: r[0], dQuote: r[1], fees: r[2] };
}

/**
 * The general edit as a batch: `[update]`, plus — when `settleIn` is one token — the one swap that
 * nets the other. The other side's flow is read off the preview: released → sold with an exact-in
 * of `OPEN_DELTA`; owed → bought with an exact-out of `OPEN_DELTA`. The settlement then binds the
 * other token to zero both ways, so a stale preview fails loudly rather than moving it.
 */
export async function edit(c: LogswapClient, a: EditArgs & { toFloor: bigint; toCap?: bigint; newL: bigint }): Promise<Hash> {
  const { key } = a;
  const recipient = resolveRecipient(c, a);
  const actions: Action[] = [
    updateAction({ key, fromId: a.fromId, shares: a.shares, toFloor: a.toFloor, toCap: a.toCap, newL: a.newL }),
  ];
  const settleIn = a.settleIn ?? "kind";
  let settle: Settle;
  if (settleIn === "kind") {
    settle = settleInKind(key, recipient, a);
  } else {
    const p = await previewEdit(c, { key, fromId: a.fromId, shares: a.shares, toFloor: a.toFloor, toCap: a.toCap, newL: a.newL });
    // the router sweeps the fees as quote before the update, so quote's open delta is fees − dQuote
    const otherFlow = settleIn === "base" ? p.dQuote - p.fees : p.dBase; // + = owed, − = released
    const otherIsBase = settleIn === "quote";
    if (otherFlow < 0n) actions.push(swapExactInAction({ key, baseIn: otherIsBase, amountIn: OPEN_DELTA }));
    else if (otherFlow > 0n) actions.push(swapExactOutAction({ key, baseOut: otherIsBase, amountOut: OPEN_DELTA }));
    settle = settleOnly(key, recipient, settleIn, {
      maxIn: settleIn === "base" ? a.maxBaseIn : a.maxQuoteIn,
      minOut: settleIn === "base" ? a.minBaseOut : a.minQuoteOut,
    });
  }
  return execute(c, { actions, settle, deadline: a.deadline, recipient });
}

/** The class behind `shares` of `id`: its floor, cap, and the exposure those shares carry. */
async function classOf(c: LogswapClient, key: PoolKey, id: bigint, shares: bigint) {
  const [d, cls] = await Promise.all([describeId(c, id, key.tickSpacing), getPositionClass(c, id)]);
  if (d.poolId === `0x${"0".repeat(64)}`) throw new Error(`logswap: id ${id} was never minted`);
  const L = cls.shares === 0n ? 0n : (cls.L * shares) / cls.shares;
  return { floor: d.floor!, cap: d.cap!, capped: d.capped, L };
}

/** Move the floor by `rungs` (signed), cap and L pinned. Positive = harvest, negative = deepen. */
export async function floor(c: LogswapClient, a: EditArgs & { rungs: bigint }): Promise<Hash> {
  const k = await classOf(c, a.key, a.fromId, a.shares);
  return edit(c, { ...a, toFloor: k.floor + a.rungs * a.key.tickSpacing, toCap: k.capped ? k.cap : undefined, newL: k.L });
}

/**
 * Raise the floor by `rungs` (default 1) and withdraw PURE QUOTE — the base leg untouched.
 *
 * A burn is in kind: it returns base and quote pro rata, so taking α of the proceeds also takes α
 * of the unsold inventory off the market. Raising the floor instead releases
 *
 *   ΔQ = L (ξ' − ξ),   ΔR = 0
 *
 * because $R = Le^{-x}$ depends on neither the floor nor the withdrawal. No base moves, the price
 * does not move, and depth is unchanged. **The cost, which a UI must show:** the position stops
 * bidding below ξ'. `settleIn: "base"` swaps the proceeds into base in the same batch.
 */
export async function harvest(c: LogswapClient, a: EditArgs & { rungs?: bigint }): Promise<Hash> {
  const n = a.rungs ?? 1n;
  if (n <= 0n) throw new Error("logswap: harvest raises the floor — rungs must be positive; to lower it, deepen()");
  return floor(c, { ...a, rungs: n });
}

/**
 * Lower the floor by `rungs` (default 1), paying L·Δξ of quote for the deeper bid — harvest's
 * mirror. `settleIn: "base"` pays it in base instead (an exact-out of the quote owed).
 */
export async function deepen(c: LogswapClient, a: EditArgs & { rungs?: bigint }): Promise<Hash> {
  const n = a.rungs ?? 1n;
  if (n <= 0n) throw new Error("logswap: deepen lowers the floor — rungs must be positive; to raise it, harvest()");
  return floor(c, { ...a, rungs: -n });
}

/** Move the cap by `rungs` (signed), floor and L pinned. Base flows while the class converts; quote once capped out. */
export async function cap(c: LogswapClient, a: EditArgs & { rungs: bigint }): Promise<Hash> {
  const k = await classOf(c, a.key, a.fromId, a.shares);
  if (!k.capped) throw new Error("logswap: cap() needs a capped class — an uncapped one has no cap to move");
  const toCap = k.cap + a.rungs * a.key.tickSpacing;
  if (toCap <= k.floor) throw new Error("logswap: the cap cannot sit at or below the floor");
  return edit(c, { ...a, toFloor: k.floor, toCap, newL: k.L });
}

/** Translate the class by `rungs` (signed): floor and cap together, width and L pinned. */
export async function shift(c: LogswapClient, a: EditArgs & { rungs: bigint }): Promise<Hash> {
  const k = await classOf(c, a.key, a.fromId, a.shares);
  const d = a.rungs * a.key.tickSpacing;
  return edit(c, { ...a, toFloor: k.floor + d, toCap: k.capped ? k.cap + d : undefined, newL: k.L });
}

/** Set the exposure to `newL`, floor and cap pinned; both legs pro rata. The mint fee bites on an increase only. */
export async function resize(c: LogswapClient, a: EditArgs & { newL: bigint }): Promise<Hash> {
  const k = await classOf(c, a.key, a.fromId, a.shares);
  return edit(c, { ...a, toFloor: k.floor, toCap: k.capped ? k.cap : undefined, newL: a.newL });
}

/** Exit `shares` — `resize(0)`. `settleIn: "quote"` (or `"base"`) leaves with one asset. */
export async function exit(c: LogswapClient, a: EditArgs): Promise<Hash> {
  const k = await classOf(c, a.key, a.fromId, a.shares);
  return edit(c, { ...a, toFloor: k.floor, toCap: k.capped ? k.cap : undefined, newL: 0n });
}

/**
 * Re-express a DORMANT class's base at a new trigger price: the base is pinned, so
 * L' = L·e^{ξ' − ξ} and nothing moves but the trigger. `toFloor` must stay above spot.
 *
 * The exponential is evaluated in double precision (~1e-16 relative), which is far inside the
 * wei-rounding of the class it produces; an exact L' is not what a trigger edit is about.
 */
export async function reprice(c: LogswapClient, a: EditArgs & { toFloor: bigint }): Promise<Hash> {
  const k = await classOf(c, a.key, a.fromId, a.shares);
  const ratio = Math.exp(Number(a.toFloor - k.floor) / 1e18);
  const newL = (k.L * BigInt(Math.round(ratio * 1e18))) / 10n ** 18n;
  return edit(c, { ...a, toFloor: a.toFloor, toCap: k.capped ? k.cap : undefined, newL });
}

/** Quote released by a harvest, exactly: ΔQ = L(ξ' − ξ). Base is untouched. */
export function harvestProceeds(L: bigint, fromFloor: bigint, toFloor: bigint): bigint {
  if (toFloor <= fromFloor) return 0n;
  return (L * (toFloor - fromFloor)) / 10n ** 18n;
}

/* burn ====================================================================== */

export interface BurnArgs extends WriteOptions {
  key: PoolKey;
  ids: readonly bigint[];
  shares: readonly bigint[];
  minBaseOut?: bigint;
  minQuoteOut?: bigint;
}

/**
 * Exit, in kind, across one or more classes. Accrued fees are swept into the same settlement.
 *
 * In kind means both legs, pro rata. To take proceeds while leaving inventory in the market, that
 * is {@link harvest}; to leave with one asset, {@link exit} with `settleIn`.
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
