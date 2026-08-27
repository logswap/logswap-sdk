/**
 * fpool.ts — the `FPoolManager` surface: n bases, one quote, one shared floor.
 *
 * The other primitive. `CPoolManager` gives every position its own floor on a tick ladder;
 * `FPoolManager` gives every share the SAME floor and deletes the ladder, the accumulators and the
 * per-position accounting with it. Reading the two side by side is the fastest way to understand
 * either (logswap-docs:docs/multi/f-pool.md).
 *
 * **A pool is an ID, not an address.** Both primitives are singletons now, so neither has a
 * per-pool deployment — but they are addressed differently and for a reason. The C manager rides
 * its whole `PoolKey` in calldata because that key is small, fixed and wholly needed. An F-pool
 * key is variable-length and only ever partially needed (no swap path is O(n)), so it is stored
 * once at `initialize` and every later call names `(poolId, j)`. Callers hold a `bytes32`.
 *
 * **Two products, one contract.** The basket (n > 1, public authority) and the launch (n = 1, the
 * creator alone on the lever) are the same bytecode under different settings — what separates them
 * is who holds `authority` and how many bases there are, and nothing in the maths. `describeFPool`
 * below reports which shape a given pool is, because a UI has to decide what to render.
 *
 * **Zaps live on the ROUTER, not here.** Permit2 is AllowanceTransfer mode, whose standing
 * allowance is keyed by spender, so a second router would cost the user an allowance per token
 * twice, forever. One router is one spender — see `fPoolZapIn`/`fPoolZapOut` below, which target
 * `addresses.router`.
 */

import { toFunctionSelector, type Address, type Hash, type Hex } from "viem";
import { fPoolManagerAbi, logswapRouterAbi } from "./generated.js";
import type { LogswapClient } from "./client.js";

const WAD = 10n ** 18n;

/** Everything scalar about a basket pool, in one round trip's worth of reads. */
export interface FPoolState {
  /** The pool's id — the hash of its key. There is no per-pool address. */
  poolId: Hex;
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
export async function getFPool(c: LogswapClient, poolId: Hex): Promise<FPoolState> {
  // viem types `functionName` as a literal union; this reader is deliberately generic, so the
  // cast lives here once rather than at each call site below.
  const rd = <T>(functionName: string, args: readonly unknown[]) =>
    c.public.readContract({
      address: c.addresses.fPoolManager!,
      abi: fPoolManagerAbi,
      functionName,
      args,
    } as never) as Promise<T>;

  // `getPool` returns the whole scalar struct in one call — the singleton's shape makes what used
  // to be a dozen getters a single read.
  const p = await rd<{
    quote: Address;
    phi: bigint;
    authority: Address;
    feesOnly: boolean;
    seeded: boolean;
    dissolved: boolean;
    n: number;
    Q: bigint;
    L: bigint;
    shares: bigint;
    theta0: bigint;
    bigSigma: bigint;
    leverTheta: bigint;
  }>("getPool", [poolId]);

  const n = Number(p.n);
  const idx = Array.from({ length: n }, (_, i) => BigInt(i));
  const [theta, compositeX, legs] = await Promise.all([
    rd<bigint>("theta", [poolId]),
    rd<bigint>("compositeX", [poolId]),
    Promise.all(idx.map((i) => rd<readonly [Address, bigint, bigint, bigint]>("legOf", [poolId, i]))),
  ]);

  const bases = legs.map((l) => l[0]);
  const weights = legs.map((l) => l[1]);
  const x = legs.map((l) => l[2]);
  // the ISOLATION SHADOW, not the derived reserve: what this pool actually holds of the token.
  // In a singleton the contract's balance backs many pools, so this is the only per-pool figure.
  const reserves = legs.map((l) => l[3]);
  const { quote, Q, L, phi, theta0, bigSigma, authority, feesOnly, seeded, dissolved } = p;
  const totalSupply = p.shares;

  return {
    poolId,
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
export type FPoolShape = "launch" | "basket";

export interface FPoolDescription {
  shape: FPoolShape;
  /** n = 1 with a private authority is the launch shape (basket-pool §6.5). */
  legs: number;
  /** True when the pool holds no quote: an all-base resting ask. base→quote is the one blocked path. */
  atFloor: boolean;
  /** Fee income earned per unit L so far, `θ₀ − θ` with the lever's displacement backed out. */
  feePerL: bigint;
  /** The model-free LP edge, `F − ½Σ`. Exact at any n: V is separable in the logs. */
  edgePerL: bigint;
}

export async function describeFPool(c: LogswapClient, s: FPoolState): Promise<FPoolDescription> {
  const rd = <T>(functionName: string) =>
    c.public.readContract({
      address: c.addresses.fPoolManager!,
      abi: fPoolManagerAbi,
      functionName,
      args: [s.poolId],
    } as never) as Promise<T>;
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
export function fPoolPriceOf(x: bigint): number {
  return Math.exp(Number(x) / 1e18);
}

/** Value per share at the pool's own marks. `V = L + Q`, so this is just that, pro-rated. */
export function fPoolShareValue(s: FPoolState): bigint {
  if (s.totalSupply === 0n) return 0n;
  return ((s.L + s.Q) * WAD) / s.totalSupply;
}

// ─── swaps ────────────────────────────────────────────────────────────────────
// Exact-in only (basket-pool §10). Three paths; the third is the one that makes a basket a basket.

export interface FPoolSwapArgs {
  poolId: Hex;
  /** Leg index into `bases`. */
  j: number;
  amountIn: bigint;
  minOut?: bigint;
  account: Address;
}

export async function fPoolSwapQuoteIn(c: LogswapClient, a: FPoolSwapArgs) {
  return writeFPool(c, a.poolId, "swapQuoteIn", [BigInt(a.j), a.amountIn, a.minOut ?? 0n], a.account);
}

export async function fPoolSwapBaseIn(c: LogswapClient, a: FPoolSwapArgs) {
  return writeFPool(c, a.poolId, "swapBaseIn", [BigInt(a.j), a.amountIn, a.minOut ?? 0n], a.account);
}

/**
 * Base j → base k, direct. Needs no quote, works at Q = 0, and cannot cross the floor: X is held
 * exactly up to the in-kind fee. Note it moves BOTH quote prices — p_j down, p_k up — because the
 * pool has one coordinate per asset and every trade moves at least one.
 */
export async function fPoolSwapBaseForBase(
  c: LogswapClient,
  a: Omit<FPoolSwapArgs, "j"> & { j: number; k: number },
) {
  return writeFPool(c, a.poolId, "swapBaseForBase", [BigInt(a.j), BigInt(a.k), a.amountIn, a.minOut ?? 0n], a.account);
}

// ─── liquidity ────────────────────────────────────────────────────────────────

/** Deposit dL/L of every reserve, receive shares ∝ dL. θ is untouched by construction. */
export async function fPoolMint(
  c: LogswapClient,
  a: { poolId: Hex; dL: bigint; maxQuoteIn?: bigint; account: Address },
) {
  return writeFPool(c, a.poolId, "mint", [a.dL, a.maxQuoteIn ?? 2n ** 256n - 1n], a.account);
}

/** Burn shares for the pro-rata slice of every reserve. Available at any Q, and after dissolution. */
export async function fPoolBurn(
  c: LogswapClient,
  a: { poolId: Hex; shares: bigint; minQuoteOut?: bigint; account: Address },
) {
  return writeFPool(c, a.poolId, "burn", [a.shares, a.minQuoteOut ?? 0n], a.account);
}

// ─── zaps (on the router — one router, one Permit2 spender) ───────────────────

/**
 * Quote needed to zap into exposure `dL`. An UPPER bound: buying each leg raises its mark, so the
 * mint consumes less base than was bought for it and every zap ends with a refund. Size from this
 * and expect change back — do not treat it as exact.
 */
export async function fPoolPreviewZapIn(c: LogswapClient, poolId: Hex, dL: bigint): Promise<bigint> {
  return c.public.readContract({
    address: c.addresses.router,
    abi: logswapRouterAbi,
    functionName: "previewZapIn",
    args: [poolId, dL],
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
export async function fPoolZapIn(
  c: LogswapClient,
  a: { poolId: Hex; dL: bigint; maxQuoteIn: bigint; minShares?: bigint; to?: Address; account: Address; deadline?: bigint },
) {
  const to = a.to ?? a.account;
  return writeRouter(
    c,
    "zapIn",
    [a.poolId, a.dL, a.maxQuoteIn, a.minShares ?? 0n, to, a.deadline ?? defaultDeadline()],
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
export async function fPoolZapOut(
  c: LogswapClient,
  a: { poolId: Hex; shares: bigint; tokenOut: Address; minOut?: bigint; to?: Address; account: Address; deadline?: bigint },
) {
  const to = a.to ?? a.account;
  return writeRouter(
    c,
    "zapOut",
    [a.poolId, a.shares, a.tokenOut, a.minOut ?? 0n, to, a.deadline ?? defaultDeadline()],
    a.account,
  );
}

// ─── the floor lever (authority only) ─────────────────────────────────────────

/**
 * Remove quote, lifting θ — price-neutral, pro-rata, no base moves. Under `feesOnly` the lift
 * stops at θ₀, so the authority extracts income and never the proceeds backing the floor.
 */
export async function fPoolHarvest(c: LogswapClient, a: { poolId: Hex; amount: bigint; to?: Address; account: Address }) {
  return writeFPool(c, a.poolId, "harvest", [a.amount, a.to ?? a.account], a.account);
}

/** Commit quote, deepening θ. The mark does not move — governance may write θ, never x. */
export async function fPoolRefill(c: LogswapClient, a: { poolId: Hex; amount: bigint; account: Address }) {
  return writeFPool(c, a.poolId, "refill", [a.amount], a.account);
}

// ─── internals ────────────────────────────────────────────────────────────────

function defaultDeadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 1800);
}

function requireWallet(c: LogswapClient) {
  if (!c.wallet) throw new Error("logswap: this call needs a wallet client");
  return c.wallet;
}

async function writeFPool(c: LogswapClient, poolId: Hex, functionName: string, args: unknown[], account: Address) {
  const wallet = requireWallet(c);
  const { request } = await c.public.simulateContract({
    address: c.addresses.fPoolManager!,
    abi: fPoolManagerAbi,
    functionName,
    // Every manager write is keyed by poolId as its FIRST parameter; prepending it here, in the
    // one place all seven helpers share, is what keeps a caller from ever omitting it. The `as
    // never` casts blind tsc to arg counts, so this file's encode test is the real guard.
    args: [poolId, ...args],
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

// ─── token readiness (two pull paths, not one) ────────────────────────────────
//
// The F screens have TWO spenders to satisfy, and confusing them was a shipped bug. Direct
// manager calls (swaps, mint, burn) pull with plain `transferFrom`, so the MANAGER needs an
// ERC-20 allowance. The router's zaps pull through Permit2 when the deployment carries one, so a
// plain approval to the router does nothing there and the zap reverts `NotAllowed()` — that leg
// is `onboardToken`'s job. This helper covers the manager leg; a UI needs both.

/** Plain ERC-20 approval to the F manager — the allowance every DIRECT call pulls against. */
export async function approveTokenForFPoolManager(c: LogswapClient, token: Address): Promise<Hash> {
  const wallet = requireWallet(c);
  return c.wallet!.writeContract({
    address: token,
    abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] }],
    functionName: "approve",
    args: [c.addresses.fPoolManager!, (1n << 256n) - 1n],
    account: wallet.account,
    chain: c.wallet!.chain,
  } as never);
}

/** Does `owner` have enough allowance on `token` for the MANAGER to pull `need`? */
export async function fPoolManagerAllowanceOk(c: LogswapClient, token: Address, owner: Address, need: bigint): Promise<boolean> {
  const allowance = (await c.public.readContract({
    address: token,
    abi: [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "allowance",
    args: [owner, c.addresses.fPoolManager!],
  } as never)) as bigint;
  return allowance >= need;
}

// ─── ERC-6909 operator (zapOut needs it) ──────────────────────────────────────
//
// The singleton's shares are ERC-6909, so the router cannot `transferFrom` them the way it could
// an ERC-20 LP token. The holder approves it once as an operator. This is the one place the move
// off a per-pool ERC-20 costs a user-visible step, so the SDK names it rather than letting the
// first `fPoolZapOut` revert with something unreadable.

export async function isRouterOperatorForFPool(c: LogswapClient, owner: Address): Promise<boolean> {
  return c.public.readContract({
    address: c.addresses.fPoolManager!,
    abi: fPoolManagerAbi,
    functionName: "isOperator",
    args: [owner, c.addresses.router],
  } as never) as Promise<boolean>;
}

/** Approve the router to move this account's F-pool shares. Needed once, before any `fPoolZapOut`. */
export async function approveRouterForFPool(c: LogswapClient, account: Address) {
  const wallet = requireWallet(c);
  const { request } = await c.public.simulateContract({
    address: c.addresses.fPoolManager!,
    abi: fPoolManagerAbi,
    functionName: "setOperator",
    args: [c.addresses.router, true],
    account,
  } as never);
  return wallet.writeContract(request as never);
}

// ─── ids ──────────────────────────────────────────────────────────────────────
//
// One ERC-6909 space, split structurally on bit 255 — the C manager's scheme. Derived here rather
// than read from the chain: it is pure, and a client that has to call to learn an id cannot build
// a multicall that uses it.

/** The ERC-6909 id carrying a pool's shares. Bit 255 set. */
export function fPoolShareId(poolId: Hex): bigint {
  return (1n << 255n) | (BigInt(poolId) >> 1n);
}

/** The ERC-6909 id carrying claims on a token. Bit 255 clear, so it can never meet a share id. */
export function fPoolClaimId(token: Address): bigint {
  return BigInt(token);
}

export async function fPoolShareBalance(c: LogswapClient, poolId: Hex, owner: Address): Promise<bigint> {
  return c.public.readContract({
    address: c.addresses.fPoolManager!,
    abi: fPoolManagerAbi,
    functionName: "balanceOf",
    args: [owner, fPoolShareId(poolId)],
  } as never) as Promise<bigint>;
}

export async function fPoolClaimBalance(c: LogswapClient, token: Address, owner: Address): Promise<bigint> {
  return c.public.readContract({
    address: c.addresses.fPoolManager!,
    abi: fPoolManagerAbi,
    functionName: "balanceOf",
    args: [owner, fPoolClaimId(token)],
  } as never) as Promise<bigint>;
}

// ─── the quoter ───────────────────────────────────────────────────────────────

export enum FPoolQuoteKind {
  QuoteIn = 0,
  BaseIn = 1,
  BaseForBase = 2,
}

/**
 * An EXACT quote — what execution returns, not an estimate.
 *
 * `quoteSwap` runs the real swap and reverts with the answer, so the value has to be decoded out
 * of the revert rather than returned. That is the point of the pattern: there is no second pricing
 * path to drift from the first. It needs no tokens, no approvals and no balance, so it works from
 * a disconnected wallet — unlike `fPoolPreviewZapIn`, which is a genuine upper bound.
 */
export async function fPoolQuoteSwap(
  c: LogswapClient,
  a: { poolId: Hex; kind: FPoolQuoteKind; j: number; k?: number; amountIn: bigint },
): Promise<bigint> {
  try {
    await c.public.simulateContract({
      address: c.addresses.fPoolManager!,
      abi: fPoolManagerAbi,
      functionName: "quoteSwap",
      args: [a.poolId, a.kind, BigInt(a.j), BigInt(a.k ?? 0), a.amountIn],
    } as never);
  } catch (err) {
    const hit = findQuoteResult(err);
    if (hit !== null) return hit;
    throw err; // a real revert — the floor stop, a bad leg — belongs to the caller
  }
  throw new Error("logswap: quoteSwap returned without reverting, which it must never do");
}

/**
 * `QuoteResult(uint256)` — selector then one word. viem nests the revert data several layers deep
 * depending on the transport, so walk for it rather than guessing the shape.
 *
 * The selector is DERIVED, not written down. A hardcoded one is wrong silently: the decode simply
 * never matches and every quote rethrows as if the swap had failed.
 */
function findQuoteResult(err: unknown): bigint | null {
  const SELECTOR = toFunctionSelector("QuoteResult(uint256)");
  const seen = new Set<unknown>();
  const walk = (e: unknown): bigint | null => {
    if (!e || typeof e !== "object" || seen.has(e)) return null;
    seen.add(e);
    const anyE = e as Record<string, unknown>;
    const data = anyE.data;
    if (typeof data === "string" && data.startsWith(SELECTOR) && data.length >= 10 + 64) {
      return BigInt("0x" + data.slice(10, 10 + 64));
    }
    for (const k of ["cause", "walk", "error", "details"]) {
      const found = walk(anyE[k]);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(err);
}
