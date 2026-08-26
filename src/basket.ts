/**
 * basket.ts — the `BasketPool` surface: n bases, one quote, one shared floor.
 *
 * The other primitive. `LogswapManager` gives every position its own floor on a tick ladder;
 * `BasketPool` gives every share the SAME floor and deletes the ladder, the accumulators and the
 * per-position accounting with it. Reading the two side by side is the fastest way to understand
 * either (logswap-docs:docs/basket-pool.md).
 *
 * **It is addressed by ADDRESS, not by key.** A market in the manager is a `PoolKey` — there is no
 * deployment. A basket pool is one contract per pool, so callers hold its address. That asymmetry
 * is real and the SDK does not hide it; hiding it would mean inventing a registry the chain does
 * not have.
 *
 * **Two products, one contract.** The basket (n > 1, public authority) and the launch (n = 1, the
 * creator alone on the lever) are the same bytecode under different settings — what separates them
 * is who holds `authority` and how many bases there are, and nothing in the maths. `describeBasket`
 * below reports which shape a given pool is, because a UI has to decide what to render.
 *
 * **Zaps live on the ROUTER, not here.** Permit2 is AllowanceTransfer mode, whose standing
 * allowance is keyed by spender, so a second router would cost the user an allowance per token
 * twice, forever. One router is one spender — see `basketZapIn`/`basketZapOut` below, which target
 * `addresses.router`.
 */

import type { Address } from "viem";
import { basketPoolAbi, logswapRouterAbi } from "./generated.js";
import type { LogswapClient } from "./client.js";

const WAD = 10n ** 18n;

/** Everything scalar about a basket pool, in one round trip's worth of reads. */
export interface BasketState {
  /** The pool's own address — a basket is a deployment, unlike a manager market. */
  address: Address;
  quote: Address;
  bases: Address[];
  /** WAD weights, summing to WAD. `L_j = w_j · L`. */
  weights: bigint[];
  /** Per-asset log prices, WAD. Price is derived; `x` is the state. */
  x: bigint[];
  /** Quote reserve. The one leg a base→quote swap can exhaust. */
  Q: bigint;
  /** Total exposure. Grows on mint, shrinks on burn; never moves on a swap. */
  L: bigint;
  /** Fixed fee, WAD. At or above `FEE_MIN` — a zero-fee basket is not constructible. */
  phi: bigint;
  /** The strike: θ at seeding, and the fees-only harvest bound. */
  theta0: bigint;
  /** θ = X − Q/L, the shared floor. Derived from the holdings, never stored. */
  theta: bigint;
  /** X = Σ w_j x_j, the composite index. */
  compositeX: bigint;
  /** Σ = ∫ Σ_j w_j (dx_j)², accrued even though the fee is fixed — the kernel stays calculable. */
  bigSigma: bigint;
  /** Creator (private) or a governance contract (public). Holds the floor lever. */
  authority: Address;
  /** Whether harvest is bounded by θ ≤ θ₀ — income only, never the floor's backing. */
  feesOnly: boolean;
  seeded: boolean;
  dissolved: boolean;
  totalSupply: bigint;
  /** Base holdings the state implies, `R_j = w_j·L·e^{−x_j}`. */
  reserves: bigint[];
}

/** Read a basket pool whole. Batched — viem multicalls these when the transport allows. */
export async function getBasket(c: LogswapClient, pool: Address): Promise<BasketState> {
  // viem types `functionName` as a literal union; this reader is deliberately generic, so the
  // cast lives here once rather than at each of the twenty call sites below.
  const rd = <T>(functionName: string, args: readonly unknown[] = []) =>
    c.public.readContract({ address: pool, abi: basketPoolAbi, functionName, args } as never) as Promise<T>;

  const n = Number(await rd<bigint>("n"));
  const idx = Array.from({ length: n }, (_, i) => BigInt(i));

  const [quote, Q, L, phi, theta0, theta, compositeX, bigSigma, authority, feesOnly, seeded, dissolved, totalSupply] =
    await Promise.all([
      rd<Address>("quote"),
      rd<bigint>("Q"),
      rd<bigint>("L"),
      rd<bigint>("phi"),
      rd<bigint>("theta0"),
      rd<bigint>("theta"),
      rd<bigint>("compositeX"),
      rd<bigint>("bigSigma"),
      rd<Address>("authority"),
      rd<boolean>("feesOnly"),
      rd<boolean>("seeded"),
      rd<boolean>("dissolved"),
      rd<bigint>("totalSupply"),
    ]);

  const [bases, weights, x, reserves] = await Promise.all([
    Promise.all(idx.map((i) => rd<Address>("bases", [i]))),
    Promise.all(idx.map((i) => rd<bigint>("w", [i]))),
    Promise.all(idx.map((i) => rd<bigint>("x", [i]))),
    Promise.all(idx.map((i) => rd<bigint>("reserveOf", [i]))),
  ]);

  return {
    address: pool,
    quote,
    bases,
    weights,
    x,
    Q,
    L,
    phi,
    theta0,
    theta,
    compositeX,
    bigSigma,
    authority,
    feesOnly,
    seeded,
    dissolved,
    totalSupply,
    reserves,
  };
}

/** Which of the two products a pool is configured as. A UI has to choose what to render. */
export type BasketShape = "launch" | "basket";

export interface BasketDescription {
  shape: BasketShape;
  /** n = 1 with a private authority is the launch shape (basket-pool §6.5). */
  legs: number;
  /** True when the pool holds no quote: an all-base resting ask. base→quote is the one blocked path. */
  atFloor: boolean;
  /** Fee income earned per unit L so far, `θ₀ − θ` with the lever's displacement backed out. */
  feePerL: bigint;
  /** The model-free LP edge, `F − ½Σ`. Exact at any n: V is separable in the logs. */
  edgePerL: bigint;
}

export async function describeBasket(c: LogswapClient, s: BasketState): Promise<BasketDescription> {
  const rd = <T>(functionName: string) =>
    c.public.readContract({ address: s.address, abi: basketPoolAbi, functionName } as never) as Promise<T>;
  const [feePerL, edgePerL] = await Promise.all([rd<bigint>("feePerL"), rd<bigint>("edgePerL")]);
  return {
    shape: s.bases.length === 1 ? "launch" : "basket",
    legs: s.bases.length,
    atFloor: s.Q === 0n,
    feePerL,
    edgePerL,
  };
}

/** `p_j = e^{x_j}`, lossy the way any float conversion is. Compare in log space when it matters. */
export function basketPriceOf(x: bigint): number {
  return Math.exp(Number(x) / 1e18);
}

/** Value per share at the pool's own marks. `V = L + Q`, so this is just that, pro-rated. */
export function basketShareValue(s: BasketState): bigint {
  if (s.totalSupply === 0n) return 0n;
  return ((s.L + s.Q) * WAD) / s.totalSupply;
}

// ─── swaps ────────────────────────────────────────────────────────────────────
// Exact-in only (basket-pool §10). Three paths; the third is the one that makes a basket a basket.

export interface BasketSwapArgs {
  pool: Address;
  /** Leg index into `bases`. */
  j: number;
  amountIn: bigint;
  minOut?: bigint;
  account: Address;
}

export async function basketSwapQuoteIn(c: LogswapClient, a: BasketSwapArgs) {
  return writeBasket(c, a.pool, "swapQuoteIn", [BigInt(a.j), a.amountIn, a.minOut ?? 0n], a.account);
}

export async function basketSwapBaseIn(c: LogswapClient, a: BasketSwapArgs) {
  return writeBasket(c, a.pool, "swapBaseIn", [BigInt(a.j), a.amountIn, a.minOut ?? 0n], a.account);
}

/**
 * Base j → base k, direct. Needs no quote, works at Q = 0, and cannot cross the floor: X is held
 * exactly up to the in-kind fee. Note it moves BOTH quote prices — p_j down, p_k up — because the
 * pool has one coordinate per asset and every trade moves at least one.
 */
export async function basketSwapBaseForBase(
  c: LogswapClient,
  a: Omit<BasketSwapArgs, "j"> & { j: number; k: number },
) {
  return writeBasket(c, a.pool, "swapBaseForBase", [BigInt(a.j), BigInt(a.k), a.amountIn, a.minOut ?? 0n], a.account);
}

// ─── liquidity ────────────────────────────────────────────────────────────────

/** Deposit dL/L of every reserve, receive shares ∝ dL. θ is untouched by construction. */
export async function basketMint(
  c: LogswapClient,
  a: { pool: Address; dL: bigint; maxQuoteIn?: bigint; account: Address },
) {
  return writeBasket(c, a.pool, "mint", [a.dL, a.maxQuoteIn ?? 2n ** 256n - 1n], a.account);
}

/** Burn shares for the pro-rata slice of every reserve. Available at any Q, and after dissolution. */
export async function basketBurn(
  c: LogswapClient,
  a: { pool: Address; shares: bigint; minQuoteOut?: bigint; account: Address },
) {
  return writeBasket(c, a.pool, "burn", [a.shares, a.minQuoteOut ?? 0n], a.account);
}

// ─── zaps (on the router — one router, one Permit2 spender) ───────────────────

/**
 * Quote needed to zap into exposure `dL`. An UPPER bound: buying each leg raises its mark, so the
 * mint consumes less base than was bought for it and every zap ends with a refund. Size from this
 * and expect change back — do not treat it as exact.
 */
export async function basketPreviewZapIn(c: LogswapClient, pool: Address, dL: bigint): Promise<bigint> {
  return c.public.readContract({
    address: c.addresses.router,
    abi: logswapRouterAbi,
    functionName: "previewZapIn",
    args: [pool, dL],
  } as never) as Promise<bigint>;
}

/**
 * Buy `dL` of the basket with quote alone.
 *
 * The imbalanced part goes through the pool's own curve before anything is minted. That is not a
 * penalty: minting against a quote-only deposit would be a zero-slippage, zero-fee swap at stale
 * spot, paid for by the existing LPs — 27.4% in basket-pool §6's worked example. Routing it through
 * the curve deletes the subsidy and hands the fee and impact to the incumbents instead.
 */
export async function basketZapIn(
  c: LogswapClient,
  a: { pool: Address; dL: bigint; maxQuoteIn: bigint; minShares?: bigint; to?: Address; account: Address; deadline?: bigint },
) {
  const to = a.to ?? a.account;
  return writeRouter(
    c,
    "zapIn",
    [a.pool, a.dL, a.maxQuoteIn, a.minShares ?? 0n, to, a.deadline ?? defaultDeadline()],
    a.account,
  );
}

/**
 * Sell shares into ONE token — the quote, or any base.
 *
 * Into a base the other legs route through `swapBaseForBase`, which needs no quote and cannot
 * cross the floor; only the burn's own quote slice touches the quote leg. Into the quote every
 * base leg is sold, which is the one path a drained quote leg can block.
 */
export async function basketZapOut(
  c: LogswapClient,
  a: { pool: Address; shares: bigint; tokenOut: Address; minOut?: bigint; to?: Address; account: Address; deadline?: bigint },
) {
  const to = a.to ?? a.account;
  return writeRouter(
    c,
    "zapOut",
    [a.pool, a.shares, a.tokenOut, a.minOut ?? 0n, to, a.deadline ?? defaultDeadline()],
    a.account,
  );
}

// ─── the floor lever (authority only) ─────────────────────────────────────────

/**
 * Remove quote, lifting θ — price-neutral, pro-rata, no base moves. Under `feesOnly` the lift
 * stops at θ₀, so the authority extracts income and never the proceeds backing the floor.
 */
export async function basketHarvest(c: LogswapClient, a: { pool: Address; amount: bigint; to?: Address; account: Address }) {
  return writeBasket(c, a.pool, "harvest", [a.amount, a.to ?? a.account], a.account);
}

/** Commit quote, deepening θ. The mark does not move — governance may write θ, never x. */
export async function basketRefill(c: LogswapClient, a: { pool: Address; amount: bigint; account: Address }) {
  return writeBasket(c, a.pool, "refill", [a.amount], a.account);
}

// ─── internals ────────────────────────────────────────────────────────────────

function defaultDeadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 1800);
}

function requireWallet(c: LogswapClient) {
  if (!c.wallet) throw new Error("logswap: this call needs a wallet client");
  return c.wallet;
}

async function writeBasket(c: LogswapClient, pool: Address, functionName: string, args: unknown[], account: Address) {
  const wallet = requireWallet(c);
  const { request } = await c.public.simulateContract({
    address: pool,
    abi: basketPoolAbi,
    functionName,
    args,
    account,
  } as never);
  return wallet.writeContract(request as never);
}

async function writeRouter(c: LogswapClient, functionName: string, args: unknown[], account: Address) {
  const wallet = requireWallet(c);
  const { request } = await c.public.simulateContract({
    address: c.addresses.router,
    abi: logswapRouterAbi,
    functionName,
    args,
    account,
  } as never);
  return wallet.writeContract(request as never);
}
