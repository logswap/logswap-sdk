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

import { encodeFunctionData, toFunctionSelector, type Address, type Hash, type Hex } from "viem";
import { fPoolManagerAbi as fPoolPrimitiveAbi, fPoolSponsorAbi, logswapRouterAbi } from "./generated.js";

/**
 * The F manager's ABI is the UNION of its two compiled halves (decisions 031): `FPoolManager`
 * holds the primitive and forwards every other selector from its fallback to `FPoolSponsor` —
 * the lever, `claim`, `dissolve`, the handover, the gates, the desk, the names — by delegatecall.
 * One address from outside, so one ABI here; both halves carry the base's events and errors,
 * and viem tolerates the duplicates.
 */
export const fPoolManagerAbi = [...fPoolPrimitiveAbi, ...fPoolSponsorAbi] as const;
import type { LogswapClient } from "./client.js";

const WAD = 10n ** 18n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

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
  /** The proposed next authority, until it accepts — zero when nothing is pending (decisions 020). */
  pendingAuthority: Address;
  /** The desk's hot key (`ma-private.md` §6): may reshape composition, never move value out. Zero when none. */
  operator: Address;
  /** The sponsor's own label for this pool, mutable and never identity. "" when unnamed. */
  name: string;
  /** Only `allowed` accounts may receive minted shares. */
  gateMint: boolean;
  /** Only `allowed` takers may swap. */
  gateSwap: boolean;
  /** The block of the last harvest / composition action: no swap runs in it. */
  restructureBlock: number;
  /**
   * The class, one bit (decisions 036; `lockFloor` in 035, `lockStrike` from 027, `feesOnly`
   * before). A PAD: `harvest` lifts the floor back to the seed floor θ₀ and never past it (income
   * only); `seed` minted every share to 0xdead, so the float and the raise can never be burned
   * out (the creator keeps the dead shares' dividend); no operator, no gate, no list — one asset,
   * open to all. A pool without it (POL, basket, desk) has every entry.
   */
  pad: boolean;
  /** False before the first seed — and between a dissolve and the next one (decisions 032). */
  seeded: boolean;
  /**
   * The live GENERATION (decisions 032). Every dissolve retires one into a frozen bundle its
   * shares redeem ({@link fPoolRedeem}) and opens the next; the share id carries it
   * ({@link fPoolShareId}), so generations `0 … gen-1` are retired claims and `gen` is the pool.
   */
  gen: number;
  totalSupply: bigint;
  /** What the pool holds of each base — the STATE since decisions 026; the mark `x` is derived from it. */
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
    pad: boolean;
    seeded: boolean;
    gen: number;
    n: number;
    restructureBlock: number;
    gateMint: boolean;
    gateSwap: boolean;
    Q: bigint;
    L: bigint;
    shares: bigint;
    theta0: bigint;
    bigSigma: bigint;
    harvestedTheta: bigint;
    pendingAuthority: Address;
    operator: Address;
    incomeTaken: bigint;
    name: Hex;
  }>("getPool", [poolId]);

  // A pool that was never created reads as an all-zero struct rather than reverting, so the
  // absence has to be named here or every caller mistakes "no such pool" for "a pool holding
  // nothing". `quote` is the manager's own existence test (`_live`), and it is what the create
  // flow's resumability turns on: an initialized-but-unseeded pool MUST still read, so this
  // cannot be a check on `seeded`.
  if (/^0x0{40}$/i.test(p.quote)) throw new Error(`logswap: no F pool with id ${poolId}`);

  const n = Number(p.n);
  const idx = Array.from({ length: n }, (_, i) => BigInt(i));
  const [theta, compositeX, legs] = await Promise.all([
    // before the seed there is no L and no floor: θ is X by convention (the manager says so since
    // bd3dd87's successor; older deployments revert with DivWadFailed, so do not ask them)
    p.L > 0n ? rd<bigint>("theta", [poolId]) : rd<bigint>("compositeX", [poolId]),
    rd<bigint>("compositeX", [poolId]),
    Promise.all(idx.map((i) => rd<readonly [Address, bigint, bigint, bigint]>("legOf", [poolId, i]))),
  ]);

  const bases = legs.map((l) => l[0]);
  const weights = legs.map((l) => l[1]);
  const x = legs.map((l) => l[2]); // derived by the manager: x_j = ln(w_j·L / R_j) (decisions 026)
  const reserves = legs.map((l) => l[3]); // the state
  const { quote, Q, L, phi, theta0, bigSigma, authority, pendingAuthority, operator, gateMint, gateSwap, restructureBlock, pad, seeded, gen } = p;
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
    pendingAuthority,
    operator,
    name: bytes32ToText(p.name),
    gateMint,
    gateSwap,
    restructureBlock: Number(restructureBlock),
    pad,
    seeded,
    gen: Number(gen),
    totalSupply,
    reserves,
  };
}

/** Which of the two products a pool is configured as. A UI has to choose what to render. */
export type FPoolShape = "launch" | "basket";

export interface FPoolDescription {
  shape: FPoolShape;
  /** n = 1 with a private authority is the launch shape (f-pool §6.5). */
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
  // an unseeded pool has no L: nothing earned, and θ (hence feePerL, hence edgePerL) is not
  // defined at L = 0. Older deployments revert with DivWadFailed rather than answering zero.
  const [feePerL, edgePerL] = s.L > 0n
    ? await Promise.all([rd<bigint>("feePerL"), rd<bigint>("edgePerL")])
    : [0n, 0n];
  return {
    shape: s.bases.length === 1 ? "launch" : "basket",
    legs: s.bases.length,
    atFloor: s.Q === 0n,
    feePerL,
    edgePerL,
  };
}

/** `p_j = e^{x_j}`, lossy the way any float conversion is. Compare in log space when it matters. */
export function fPoolPriceOf(x: bigint, scale = 1): number {
  return Math.exp(Number(x) / 1e18) * scale;
}

/** Value per share at the pool's own marks. `V = L + Q`, so this is just that, pro-rated. */
export function fPoolShareValue(s: FPoolState): bigint {
  if (s.totalSupply === 0n) return 0n;
  return ((s.L + s.Q) * WAD) / s.totalSupply;
}

// ─── swaps ────────────────────────────────────────────────────────────────────
// Exact-in only (f-pool §10). Three paths; the third is the one that makes a basket a basket.

export interface FPoolSwapArgs {
  poolId: Hex;
  /** Leg index into `bases`. */
  j: number;
  amountIn: bigint;
  minOut?: bigint;
  /** Who receives the out leg. Defaults to the account. */
  to?: Address;
  /** Absolute unix seconds. Defaulted to a bounded window, as every router write is. */
  deadline?: bigint;
  account: Address;
}

/**
 * All three F swaps go through the ROUTER's `swapExactIn` overload — the same surface as a C
 * swap: Permit2 pull, `minOut`, recipient, deadline. The manager's direct `swapQuoteIn` etc.
 * remain callable (plain allowance to the manager, settle to caller) but are the primitive's
 * interface, not the SDK's: routing everywhere is what keeps the two pools identical to use.
 */
async function fSwap(c: LogswapClient, a: FPoolSwapArgs, kind: FPoolQuoteKind, k = 0) {
  const st = await getFPool(c, a.poolId);
  const pull = kind === FPoolQuoteKind.QuoteIn ? st.quote : st.bases[a.j]!;
  return writeRouter(
    c,
    "swapExactIn",
    [a.poolId, kind, BigInt(a.j), BigInt(k), a.amountIn, a.minOut ?? 0n, a.to ?? a.account, a.deadline ?? defaultDeadline()],
    a.account,
    [pull],
  );
}

export async function fPoolSwapQuoteIn(c: LogswapClient, a: FPoolSwapArgs) {
  return fSwap(c, a, FPoolQuoteKind.QuoteIn);
}

export async function fPoolSwapBaseIn(c: LogswapClient, a: FPoolSwapArgs) {
  return fSwap(c, a, FPoolQuoteKind.BaseIn);
}

/**
 * Base j → base k. Needs no quote, works at Q = 0, and cannot cross the floor: X is held
 * exactly up to the in-kind fee. Note it moves BOTH quote prices — p_j down, p_k up — because the
 * pool has one coordinate per asset and every trade moves at least one.
 */
export async function fPoolSwapBaseForBase(c: LogswapClient, a: FPoolSwapArgs & { k: number }) {
  return fSwap(c, a, FPoolQuoteKind.BaseForBase, a.k);
}

// ─── liquidity ────────────────────────────────────────────────────────────────

/** Deposit dL/L of every reserve, receive shares ∝ dL. θ is untouched by construction. */
export async function fPoolMint(
  c: LogswapClient,
  a: { poolId: Hex; dL: bigint; maxQuoteIn?: bigint; account: Address; to?: Address },
) {
  // shares go to `to` (the account by default); on a gated pool `to` must be allowed
  return writeFPool(c, a.poolId, "mint", [a.to ?? a.account, a.dL, a.maxQuoteIn ?? 2n ** 256n - 1n], a.account);
}

/**
 * Burn shares for the pro-rata slice of every reserve. Available at any Q, and after dissolution.
 * By owner since contracts `c782811` (decisions 019): the account burns its own shares; an
 * operator may pass another owner's address, as on the C manager's `burnById`.
 */
export async function fPoolBurn(
  c: LogswapClient,
  a: { poolId: Hex; shares: bigint; minQuoteOut?: bigint; account: Address; owner?: Address },
) {
  return writeFPool(c, a.poolId, "burn", [a.owner ?? a.account, a.shares, a.minQuoteOut ?? 0n], a.account);
}

// ─── zaps (on the router — one router, one Permit2 spender) ───────────────────

/**
 * Quote needed to zap into exposure `dL`. An UPPER bound: buying each leg raises its mark, so the
 * mint consumes less base than was bought for it and every zap ends with a refund. Size from this
 * and expect change back — do not treat it as exact.
 */
export async function fPoolPreviewZapIn(c: LogswapClient, poolId: Hex, dL: bigint): Promise<bigint> {
  // read-only lives on the LENS (the router's F flows moved to a facet; its previews came here)
  const { logswapLensAbi } = await import("./generated.js");
  return c.public.readContract({
    address: c.addresses.lens,
    abi: logswapLensAbi,
    functionName: "previewZapIn",
    args: [poolId, dL],
  } as never) as Promise<bigint>;
}

/**
 * Buy `dL` of the basket with quote alone.
 *
 * The imbalanced part goes through the pool's own curve before anything is minted. That is not a
 * penalty: minting against a quote-only deposit would be a zero-slippage, zero-fee swap at stale
 * spot, paid for by the existing LPs — 27.4% in f-pool §6's worked example. Routing it through
 * the curve deletes the subsidy and hands the fee and impact to the incumbents instead.
 */
export async function fPoolZapIn(
  c: LogswapClient,
  a: { poolId: Hex; dL: bigint; maxQuoteIn: bigint; minShares?: bigint; to?: Address; account: Address; deadline?: bigint },
) {
  const to = a.to ?? a.account;
  const st = await getFPool(c, a.poolId);
  return writeRouter(
    c,
    "zapIn",
    [a.poolId, a.dL, a.maxQuoteIn, a.minShares ?? 0n, to, a.deadline ?? defaultDeadline()],
    a.account,
    [st.quote],
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

/**
 * Roll a retired generation's bundle into the pool's live one (decisions 025, 032), on the
 * router under one lock: redeem `shares` of generation `gen` in place — the legs, the quote and
 * any unpulled dividend come back — buy through the pool's own curve only what the live
 * generation's ratio lacks, mint `dL` of it to `to`, and refund the rest in kind. Quote the
 * bundle does not cover is pulled from the payer, at most `maxQuoteIn`; surplus base is
 * refunded, never sold. Size `dL` with {@link fPoolPreviewRollIn}. The router must be the
 * caller's ERC-6909 operator ({@link approveRouterForFPool}).
 */
export async function fPoolRollIn(
  c: LogswapClient,
  a: {
    poolId: Hex;
    /** the retired generation whose shares roll */
    gen: bigint | number;
    shares: bigint;
    dL: bigint;
    maxQuoteIn?: bigint;
    minShares?: bigint;
    to?: Address;
    account: Address;
    deadline?: bigint;
  },
) {
  const to = a.to ?? a.account;
  return writeRouter(
    c,
    "rollIn",
    [a.poolId, BigInt(a.gen), a.shares, a.dL, a.maxQuoteIn ?? 0n, a.minShares ?? 0n, to, a.deadline ?? defaultDeadline()],
    a.account,
  );
}

/**
 * The roll `holder`'s `shares` of retired generation `gen` fund into the live one WITHOUT a
 * trade: the largest `dL` the bundle's base covers on every leg, and the quote the bundle is
 * short of (pass it as `maxQuoteIn`) or over (refunded — the up direction's distribution) at
 * that `dL`. A leg the live generation admitted since makes `dL` zero: such a roll must buy, so
 * size it below with `previewZapIn` in mind. Zero for the live generation, or before the next
 * seed.
 */
export async function fPoolPreviewRollIn(
  c: LogswapClient,
  poolId: Hex,
  gen: bigint | number,
  holder: Address,
  shares: bigint,
): Promise<{ dL: bigint; quoteShort: bigint; quoteExcess: bigint }> {
  const { logswapLensAbi } = await import("./generated.js");
  const [dL, quoteShort, quoteExcess] = (await c.public.readContract({
    address: c.addresses.lens,
    abi: logswapLensAbi,
    functionName: "previewRollIn",
    args: [poolId, BigInt(gen), holder, shares],
  } as never)) as readonly [bigint, bigint, bigint];
  return { dL, quoteShort, quoteExcess };
}

// ─── the floor lever (authority only) ─────────────────────────────────────────

/**
 * Remove quote, lifting θ — price-neutral, no base moves, and since decisions 028 a DIVIDEND to
 * every share: the amount goes into the pool's pot and each holder's slice is settled lazily on
 * their next transfer, mint or burn, or pulled with {@link fPoolClaim}. The sponsor's own slice —
 * its shares' and the locked seed's at 0xdead — is pushed to `to` at once. On a pad
 * the lift stops at the seed floor θ₀ (income only); nothing else bounds it (decisions 035) — an
 * unlocked pool's authority may take Q to zero.
 */
export async function fPoolHarvest(c: LogswapClient, a: { poolId: Hex; amount: bigint; to?: Address; account: Address }) {
  return writeFPool(c, a.poolId, "harvest", [a.amount, a.to ?? a.account], a.account);
}

/**
 * Pull one's settled dividend (decisions 028) on a generation's shares without moving them;
 * anyone with shares. `gen` defaults to the live generation; a retired generation's harvests
 * stay claimable under its own id (decisions 032).
 */
export async function fPoolClaim(c: LogswapClient, a: { poolId: Hex; gen?: bigint | number; to?: Address; account: Address }) {
  const gen = a.gen ?? (await fPoolGen(c, a.poolId));
  return writeFPool(c, a.poolId, "claim", [BigInt(gen), a.to ?? a.account], a.account);
}

/** A holder's dividend as of now on generation `gen` (the live one by default) — banked plus pending on the current balance (decisions 028). */
export async function fPoolDividendOf(c: LogswapClient, poolId: Hex, holder: Address, gen?: bigint | number): Promise<bigint> {
  const g = gen ?? (await fPoolGen(c, poolId));
  return c.public.readContract({
    address: c.addresses.fPoolManager!,
    abi: fPoolManagerAbi,
    functionName: "dividendOf",
    args: [poolId, BigInt(g), holder],
  } as never) as Promise<bigint>;
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

/** A manager write that is NOT keyed by a poolId — `multicall`. */
async function writeFPool0(c: LogswapClient, functionName: string, args: unknown[], account: Address) {
  const wallet = requireWallet(c);
  const { request } = await c.public.simulateContract({
    address: c.addresses.fPoolManager!,
    abi: fPoolManagerAbi,
    functionName,
    args,
    account,
  } as never);
  return wallet.writeContract(request as never);
}

async function writeRouter(
  c: LogswapClient,
  functionName: string,
  args: unknown[],
  account: Address,
  /** Tokens the call pulls: missing Permit2 allowances are SIGNED and ride in the same tx. */
  pullTokens: Address[] = [],
) {
  const wallet = requireWallet(c);
  let fn = functionName;
  let sendArgs: unknown[] = args;
  if (pullTokens.length) {
    const { permit2SigCalls } = await import("./onboard.js");
    const sigCalls = await permit2SigCalls(c, pullTokens).catch(() => []);
    if (sigCalls.length) {
      const { encodeFunctionData } = await import("viem");
      const inner = encodeFunctionData({ abi: logswapRouterAbi, functionName, args } as never);
      fn = "multicall";
      sendArgs = [[...sigCalls, inner]];
    }
  }
  const { request } = await c.public.simulateContract({
    address: c.addresses.router,
    abi: logswapRouterAbi,
    functionName: fn,
    args: sendArgs,
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

/**
 * The ERC-6909 id carrying generation `gen` of a pool's shares (decisions 032): bit 255 set (the
 * share flag), the pool id's top 239 bits, the generation in the low 16. Each generation's shares
 * are their own asset — a retired one is a claim on its bundle, the live one on the pool.
 */
export function fPoolShareId(poolId: Hex, gen: bigint | number = 0n): bigint {
  return (1n << 255n) | ((BigInt(poolId) >> 17n) << 16n) | BigInt(gen);
}

/** The generation a share id carries — its low 16 bits. */
export function fPoolGenOfShareId(id: bigint): number {
  return Number(id & 0xffffn);
}

/** The pool's live generation, one read. */
export async function fPoolGen(c: LogswapClient, poolId: Hex): Promise<number> {
  const p = (await c.public.readContract({
    address: c.addresses.fPoolManager!,
    abi: fPoolManagerAbi,
    functionName: "getPool",
    args: [poolId],
  } as never)) as { gen: number };
  return Number(p.gen);
}

/** The ERC-6909 id carrying claims on a token. Bit 255 clear, so it can never meet a share id. */
export function fPoolClaimId(token: Address): bigint {
  return BigInt(token);
}

/** A holder's shares of generation `gen` — the live one by default. */
export async function fPoolShareBalance(c: LogswapClient, poolId: Hex, owner: Address, gen?: bigint | number): Promise<bigint> {
  const g = gen ?? (await fPoolGen(c, poolId));
  return c.public.readContract({
    address: c.addresses.fPoolManager!,
    abi: fPoolManagerAbi,
    functionName: "balanceOf",
    args: [owner, fPoolShareId(poolId, g)],
  } as never) as Promise<bigint>;
}

/** A retired generation's bundle (decisions 032): what is left to redeem — supply, quote, base per leg index. */
export async function fPoolBundleOf(
  c: LogswapClient,
  poolId: Hex,
  gen: bigint | number,
): Promise<{ supply: bigint; quote: bigint; base: bigint[] }> {
  const [supply, quote, base] = (await c.public.readContract({
    address: c.addresses.fPoolManager!,
    abi: fPoolManagerAbi,
    functionName: "bundleOf",
    args: [poolId, BigInt(gen)],
  } as never)) as readonly [bigint, bigint, readonly bigint[]];
  return { supply, quote, base: [...base] };
}

/** A holder's claim on one retired generation, as the lens reports it: what `redeem` pays now. */
export interface FPoolClaimRow {
  gen: number;
  shares: bigint;
  base: bigint[];
  quote: bigint;
  dividend: bigint;
}

/** A holder's claims on a pool's retired generations — one row per generation still held (decisions 032). */
export async function fPoolClaimsOf(c: LogswapClient, poolId: Hex, owner: Address): Promise<FPoolClaimRow[]> {
  const { logswapLensAbi } = await import("./generated.js");
  const rows = (await c.public.readContract({
    address: c.addresses.lens,
    abi: logswapLensAbi,
    functionName: "fClaimsOf",
    args: [poolId, owner],
  } as never)) as readonly { gen: bigint; shares: bigint; base: readonly bigint[]; quote: bigint; dividend: bigint }[];
  return rows.map((r) => ({ gen: Number(r.gen), shares: r.shares, base: [...r.base], quote: r.quote, dividend: r.dividend }));
}

/**
 * Redeem `shares` of a RETIRED generation (decisions 032): its bundle, pro rata — the base per
 * leg and the quote — plus the owner's settled dividend. Not `burn`: nothing can move a bundle's
 * ratio, so there is no slippage to bound. The owner, or an operator of theirs.
 */
export async function fPoolRedeem(
  c: LogswapClient,
  a: { poolId: Hex; gen: bigint | number; shares: bigint; owner?: Address; account: Address },
) {
  return writeFPool(c, a.poolId, "redeem", [BigInt(a.gen), a.owner ?? a.account, a.shares], a.account);
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
  a: { poolId: Hex; kind: FPoolQuoteKind; j: number; k?: number; amountIn: bigint; taker?: Address },
): Promise<bigint> {
  try {
    await c.public.simulateContract({
      address: c.addresses.fPoolManager!,
      abi: fPoolManagerAbi,
      functionName: "quoteSwap",
      // the taker matters only on a gated pool: the connected account, or the zero address
      args: [a.poolId, a.kind, BigInt(a.j), BigInt(a.k ?? 0), a.amountIn, a.taker ?? c.wallet?.account?.address ?? ZERO_ADDRESS],
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

// ─── the pool lifecycle (creation to dissolution) ─────────────────────────────
//
// Everything here is MANAGER-DIRECT by design: creation and governance are one-time,
// authority-gated acts with no pull to route and no slippage to bound, so the router adds
// nothing and its 128 bytes of EIP-170 margin are not spent on them.

export interface FPoolCreateArgs {
  quote: Address;
  /** Legs in any order; sorted (with weights and marks kept aligned) before the call. */
  bases: Address[];
  /** WAD each; must sum to 1e18 — validated here so the revert is readable. */
  weights: bigint[];
  /** Fixed fee, WAD. The base-for-base fee is pinned at 2φ on-chain. */
  phi: bigint;
  /** true: the strike is locked — harvest stops at θ₀ and the pool cannot be dissolved live (the pad's posture; decisions 027). */
  pad: boolean;
  authority: Address;
  /**
   * The differentiator, and nothing else. Identity is the key's hash, so one sponsor cannot run
   * two pools of the same shape without varying it — the second `initialize` would land on the
   * first pool's id. Defaults to zero, which is the first book of any shape. A pool's NAME is not
   * this: names are mutable state (`fPoolSetName`), so a rename forks nothing.
   */
  salt?: Hex;
  account: Address;
}

const ZERO_SALT = `0x${"0".repeat(64)}` as const;

/** `bytes32` ⇄ short UTF-8 text, for the pool and sponsor labels. */
export function textToBytes32(text: string): Hex {
  const b = new TextEncoder().encode(text);
  if (b.length > 31) throw new Error(`logswap: "${text}" is ${b.length} bytes; a label holds 31`);
  const out = new Uint8Array(32);
  out.set(b);
  return `0x${Array.from(out, (x) => x.toString(16).padStart(2, "0")).join("")}` as Hex;
}
export function bytes32ToText(word: Hex): string {
  if (!word) return ""; // a manager older than the field answers with nothing at all
  const bytes = (word.slice(2).match(/../g) ?? []).map((h) => parseInt(h, 16));
  const end = bytes.findIndex((x) => x === 0);
  return new TextDecoder().decode(new Uint8Array(end === -1 ? bytes : bytes.slice(0, end)));
}

/** Sort legs by base address (the key's canonical order), carrying companion arrays along. */
export function sortFPoolLegs<T>(bases: Address[], ...companions: T[][]): { bases: Address[]; companions: T[][] } {
  const idx = bases.map((_, i) => i).sort((a, b) => (bases[a]!.toLowerCase() < bases[b]!.toLowerCase() ? -1 : 1));
  return { bases: idx.map((i) => bases[i]!), companions: companions.map((arr) => idx.map((i) => arr[i]!)) };
}

/** Create the pool (no funds move — `seed` arms it). Returns the tx hash; read the id with `fPoolIdOf`. */
export async function fPoolInitialize(c: LogswapClient, a: FPoolCreateArgs) {
  const sum = a.weights.reduce((x, y) => x + y, 0n);
  if (sum !== 10n ** 18n) throw new Error(`logswap: weights sum to ${sum}, expected 1e18`);
  const { bases, companions } = sortFPoolLegs(a.bases, a.weights);
  const key = { quote: a.quote, bases, weights: companions[0]!, phi: a.phi, pad: a.pad, authority: a.authority, salt: a.salt ?? ZERO_SALT };
  const wallet = requireWallet(c);
  const { request } = await c.public.simulateContract({
    address: c.addresses.fPoolManager!,
    abi: fPoolManagerAbi,
    functionName: "initialize",
    args: [key],
    account: wallet.account,
  } as never);
  return c.wallet!.writeContract(request as never);
}

/** The pool id is the key's hash — pure, so it can be read before or after creation. */
export async function fPoolIdOf(c: LogswapClient, a: Omit<FPoolCreateArgs, "account">): Promise<Hex> {
  const { bases, companions } = sortFPoolLegs(a.bases, a.weights);
  const key = { quote: a.quote, bases, weights: companions[0]!, phi: a.phi, pad: a.pad, authority: a.authority, salt: a.salt ?? ZERO_SALT };
  return c.public.readContract({
    address: c.addresses.fPoolManager!,
    abi: fPoolManagerAbi,
    functionName: "idOf",
    args: [key],
  } as never) as Promise<Hex>;
}

/**
 * The reserve a leg holds at a mark: `R = Lj·e^{−x}`, WAD math. The seed names RESERVES since
 * decisions 029 — the sponsor states holdings and the price follows, `p = Lj / R` — so this is
 * the one conversion from a price to what the pool will hold, done here, on the way in. Float
 * precision (~1e-16 relative) is what a seed needs: any reserve is a legal seed, and the mark
 * the pool derives from it is the one the sponsor meant to within that.
 */
export function fPoolReserveAt(Lj: bigint, x: bigint): bigint {
  const e = Math.exp(-Number(x) / 1e18);
  return (Lj * BigInt(Math.round(e * 1e18))) / 10n ** 18n;
}

/**
 * Arm the pool: deposit `r0[j]` of each base plus `Q0` of quote against exposure `L0`. Pass either
 * the reserves outright (`r0`) or the marks the pool should open at (`x0`, converted here with
 * {@link fPoolReserveAt} against the key's weights). Authority-only on-chain (an open seed lets
 * anyone front-run the creator for the strike). Arrays align with the SORTED bases — use
 * {@link sortFPoolLegs} on (bases, weights, x0) together when building forms.
 */
export async function fPoolSeed(
  c: LogswapClient,
  a: { poolId: Hex; L0: bigint; Q0: bigint; account: Address } & ({ r0: bigint[] } | { x0: bigint[]; weights: bigint[] }),
) {
  const r0 = "r0" in a ? a.r0 : a.x0.map((x, j) => fPoolReserveAt((a.weights[j]! * a.L0) / 10n ** 18n, x));
  return writeFPool(c, a.poolId, "seed", [a.L0, r0, a.Q0], a.account);
}

/**
 * Retire the live generation (decisions 025, 032, 035) — the raw entry. Allowed only at an empty
 * bid, Q ≤ L/1e9, on every pool: the market took it, or the authority harvested it out first
 * ({@link fPoolRetire} does both in one transaction). The live (S, Q, R_j) become a frozen bundle
 * every share of this generation redeems ({@link fPoolRedeem}) or rolls ({@link fPoolRollIn}),
 * forever; the pool is unseeded until the next {@link fPoolSeed}, which opens generation
 * `gen + 1` under the same id, gates and lists.
 */
export async function fPoolDissolve(c: LogswapClient, a: { poolId: Hex; account: Address }) {
  return writeFPool(c, a.poolId, "dissolve", [], a.account);
}

/**
 * Retire the live generation as ONE transaction: the harvests that empty the bid
 * ({@link fPoolEmptyingHarvests} — a dividend to every share; none when it is already empty),
 * then `dissolve` — the manager's `multicall`, the authority as sender. What a sponsor's
 * "dissolve" button should call. Throws before sending on a pad that still bids.
 */
export async function fPoolRetire(c: LogswapClient, a: { poolId: Hex; account: Address }) {
  const harvests = await fPoolEmptyingHarvests(c, a.poolId);
  if (harvests.length === 0) return fPoolDissolve(c, a);
  const enc = (functionName: string, args: unknown[]) =>
    encodeFunctionData({ abi: fPoolManagerAbi, functionName, args } as never) as Hex;
  const calls: Hex[] = [...harvests.map((amount) => enc("harvest", [a.poolId, amount, a.account])), enc("dissolve", [a.poolId])];
  return writeFPool0(c, "multicall", [calls], a.account);
}

/**
 * The harvests that empty an unlocked pool's bid, in order — what a relaunch sends before its
 * `dissolve` (decisions 035: a dissolve needs an empty bid on every pool). One `harvest(Q)` when a
 * collector is set. With none, the cut on income STAYS in the pool as LP quote (decisions 002)
 * and reads as taken income, so a second harvest — capital, no cut — takes the rest; the
 * contract's own arithmetic, replayed. `[]` when the bid is already empty. Throws on a
 * pad that still bids (its bid empties only as the market sells it down), and in
 * the one shape two harvests cannot empty (no collector, income above Q — harvest by hand).
 */
export async function fPoolEmptyingHarvests(c: LogswapClient, poolId: Hex): Promise<bigint[]> {
  const rd = <T>(functionName: string, args: readonly unknown[] = []) =>
    c.public.readContract({ address: c.addresses.fPoolManager!, abi: fPoolManagerAbi, functionName, args } as never) as Promise<T>;
  const [p, feePerL, fee, exempt, collector] = await Promise.all([
    rd<{ Q: bigint; L: bigint; pad: boolean; incomeTaken: bigint }>("getPool", [poolId]),
    rd<bigint>("feePerL", [poolId]),
    rd<bigint>("HARVEST_FEE"),
    rd<boolean>("harvestFeeExempt", [poolId]),
    rd<Address>("feeCollector"),
  ]);
  if (p.Q === 0n) return [];
  if (p.pad) throw new Error("logswap: a pad is retired only once its bid is empty (decisions 035)");
  const earned = feePerL > 0n ? (feePerL * p.L) / WAD : 0n;
  let taken = p.incomeTaken;
  let q = p.Q;
  const amounts: bigint[] = [];
  for (let i = 0; i < 2 && q > 0n; i++) {
    const amount = q;
    const left = earned > taken ? earned - taken : 0n;
    const taxable = amount < left ? amount : left;
    taken += taxable;
    const pFee = exempt ? 0n : (taxable * fee) / WAD;
    const leaving = pFee !== 0n && collector !== ZERO_ADDRESS ? amount : amount - pFee;
    q -= leaving;
    amounts.push(amount);
  }
  if (q > 0n) throw new Error("logswap: the bid does not empty in two harvests (no collector, income above Q) — harvest by hand first");
  return amounts;
}

/**
 * The sponsor's relaunch as ONE transaction (decisions 025, 032, 035): `harvest` the bid out —
 * a dividend to every share, {@link fPoolEmptyingHarvests} — `dissolve` the live generation at
 * the empty bid, `redeem` the sponsor's own shares of it (when `shares` > 0), `seed` the next
 * generation with what came back — the manager's `multicall`, the sponsor as sender throughout,
 * the same pool. Gates, allowlist, operator and names carry over; anything else goes in `extra`,
 * pre-encoded against {@link fPoolManagerAbi}. The seed names reserves (decisions 029): `r0`
 * outright, or `x0` marks against the key's `weights`.
 */
export async function fPoolRelaunch(
  c: LogswapClient,
  a: {
    poolId: Hex;
    /** the sponsor's shares of the retiring generation to redeem inside the batch — its whole balance, usually; 0 to keep the claim */
    shares: bigint;
    L0: bigint;
    Q0: bigint;
    extra?: Hex[];
    account: Address;
  } & ({ r0: bigint[] } | { x0: bigint[]; weights: bigint[] }),
) {
  const [gen, harvests] = await Promise.all([fPoolGen(c, a.poolId), fPoolEmptyingHarvests(c, a.poolId)]);
  const r0 = "r0" in a ? a.r0 : a.x0.map((x, j) => fPoolReserveAt((a.weights[j]! * a.L0) / WAD, x));
  const enc = (functionName: string, args: unknown[]) =>
    encodeFunctionData({ abi: fPoolManagerAbi, functionName, args } as never) as Hex;
  const calls: Hex[] = [
    ...harvests.map((amount) => enc("harvest", [a.poolId, amount, a.account])),
    enc("dissolve", [a.poolId]),
    ...(a.shares > 0n ? [enc("redeem", [a.poolId, BigInt(gen), a.account, a.shares])] : []),
    enc("seed", [a.poolId, a.L0, r0, a.Q0]),
    ...(a.extra ?? []),
  ];
  return writeFPool0(c, "multicall", [calls], a.account);
}

/** Where a pad's seed lives (decisions 036): `seed` mints every share of a pad here itself. */
export const DEAD_ADDRESS: Address = "0x000000000000000000000000000000000000dEaD";
/** The manager's `MIN_SHARES`: the seed mints this much to 0xdead on every pool, the rest to the seeder — or, on a pad, to 0xdead too. */
export const F_MIN_SHARES = 1000n;

export interface FPoolLaunchArgs extends Omit<FPoolCreateArgs, "account"> {
  L0: bigint;
  /** Quote the seed pulls. A pad seeds at 0 — pure float, a resting ask, nothing raised. */
  Q0: bigint;
  /**
   * An opening buy of leg `j` (an index into `bases` AS GIVEN) for `amountIn` of quote, ON THE
   * MANAGER — the same sender, a plain allowance to the manager, the router nowhere near it. A
   * pad seeds at Q = 0, so until someone trades it the mark sits at p₀; buying inside the launch
   * gives it a price that has moved and a buffer under it. Nothing can trade between the seed and
   * this buy — they are one transaction — so `minOut` is safe at its default of 0.
   */
  openBuy?: { j: number; amountIn: bigint; minOut?: bigint };
  /** The pool's label, set in the batch (≤ 31 bytes of UTF-8). */
  name?: string;
  /** Gate minting, list the creator, appoint them operator (decisions 021) — three calls, in the batch. */
  privatePool?: boolean;
  /**
   * The pool already exists (a previous launch got as far as `initialize` and no further — a seed
   * that reverted, a closed tab, before the launch was one transaction), so `initialize` is left
   * out: the key is a pure function of the arguments and a second `initialize` can only revert.
   */
  initialized?: boolean;
  /** Anything else, pre-encoded against {@link fPoolManagerAbi}, appended after the above. */
  extra?: Hex[];
  account: Address;
}

/**
 * The launch's calls, in order — the batch {@link fPoolLaunch} sends. Pure, so a form can show
 * what it is about to send, and a test can decode it. Legs are sorted here with their weights and
 * reserves (the key's canonical order; `openBuy.j` is re-indexed to match), and the weights are
 * checked here, where the message is readable.
 */
export function fPoolLaunchCalls(
  poolId: Hex,
  a: FPoolLaunchArgs & ({ r0: bigint[] } | { x0: bigint[] }),
): Hex[] {
  const sum = a.weights.reduce((x, y) => x + y, 0n);
  if (sum !== WAD) throw new Error(`logswap: weights sum to ${sum}, expected 1e18`);
  const given = "r0" in a ? a.r0 : a.x0.map((x, j) => fPoolReserveAt((a.weights[j]! * a.L0) / WAD, x));
  if (given.length !== a.bases.length) throw new Error(`logswap: ${given.length} reserves for ${a.bases.length} legs`);
  const { bases, companions } = sortFPoolLegs(a.bases, a.weights, given);
  const key = { quote: a.quote, bases, weights: companions[0]!, phi: a.phi, pad: a.pad, authority: a.authority, salt: a.salt ?? ZERO_SALT };
  const enc = (functionName: string, args: unknown[]) =>
    encodeFunctionData({ abi: fPoolManagerAbi, functionName, args } as never) as Hex;
  const calls: Hex[] = [];
  if (!a.initialized) calls.push(enc("initialize", [key]));
  calls.push(enc("seed", [poolId, a.L0, companions[1]!, a.Q0]));
  // gen 0 by construction: a launch is the pool's FIRST seed — a relaunch is `fPoolRelaunch`.
  // No transfer to 0xdead: on a pad `seed` mints every share there itself (decisions 036).
  if (a.openBuy) {
    const j = bases.indexOf(a.bases[a.openBuy.j]!);
    if (j < 0) throw new Error(`logswap: openBuy.j = ${a.openBuy.j} is not a leg`);
    calls.push(enc("swapQuoteIn", [poolId, BigInt(j), a.openBuy.amountIn, a.openBuy.minOut ?? 0n, a.account]));
  }
  if (a.name) calls.push(enc("setName", [poolId, textToBytes32(a.name)]));
  if (a.privatePool) {
    calls.push(enc("setGates", [poolId, true, false]));
    calls.push(enc("setAllowed", [poolId, [a.account], true]));
    calls.push(enc("appointOperator", [poolId, a.account]));
  }
  calls.push(...(a.extra ?? []));
  return calls;
}

/**
 * Create a pool as ONE transaction: `initialize`, `seed`, the seed lock, the opening buy, the
 * name, the private-pool gates — the manager's `multicall`, the creator as sender throughout.
 * Either every call lands or none does; there is no half-built pool to resume.
 *
 * Why the manager and not the router: every one of these entries authenticates by `msg.sender`
 * (`seed` is authority-only, so is everything after it). Routed, the router would be the sender
 * — the authority, the holder of the seed shares — and the handover back is two-step, so it
 * could not even close in the same transaction. `multicall` is delegatecall-to-self, so the
 * sender survives, which is what the manager's own doc says a router cannot do.
 *
 * What the batch PULLS, by plain allowance to the manager (never Permit2): `r0[j]` of each base,
 * `Q0` of quote, plus `openBuy.amountIn` of quote. Grant those first — one `approve` per token,
 * once ever ({@link approveTokenForFPoolManager}, {@link fPoolManagerAllowanceOk}).
 *
 * Returns the hash and the pool's id (the key's hash, {@link fPoolIdOf}).
 */
export async function fPoolLaunch(
  c: LogswapClient,
  a: FPoolLaunchArgs & ({ r0: bigint[] } | { x0: bigint[] }),
): Promise<{ hash: Hash; poolId: Hex }> {
  const poolId = await fPoolIdOf(c, a);
  const hash = await writeFPool0(c, "multicall", [fPoolLaunchCalls(poolId, a)], a.account);
  return { hash, poolId };
}

/**
 * Propose the next authority — step one of two (contracts `2aa6b7b`, decisions 020). Nothing moves
 * until `next` accepts; proposing again (the zero address included) cancels a pending proposal.
 * Indexed on-chain via AuthorityProposed.
 */
export async function fPoolProposeAuthority(c: LogswapClient, a: { poolId: Hex; next: Address; account: Address }) {
  return writeFPool(c, a.poolId, "proposeAuthority", [a.next], a.account);
}

/** Accept a pending proposal — step two; only the proposed address can. Indexed via AuthoritySet. */
export async function fPoolAcceptAuthority(c: LogswapClient, a: { poolId: Hex; account: Address }) {
  return writeFPool(c, a.poolId, "acceptAuthority", [], a.account);
}

// ─── the sponsor's controls and the desk (contracts bd3dd87, decisions 021) ───────────────

/** Turn the mint / swap gates on or off (authority). `burn` is never gated. */
export async function fPoolSetGates(
  c: LogswapClient,
  a: { poolId: Hex; gateMint: boolean; gateSwap: boolean; account: Address },
) {
  return writeFPool(c, a.poolId, "setGates", [a.gateMint, a.gateSwap], a.account);
}

/** Add to or remove from the pool's list, in one call (authority). */
export async function fPoolSetAllowed(
  c: LogswapClient,
  a: { poolId: Hex; who: readonly Address[]; allowed: boolean; account: Address },
) {
  return writeFPool(c, a.poolId, "setAllowed", [a.who, a.allowed], a.account);
}

/** Whether `who` is on the pool's list (consulted only while a gate is on). */
export async function fPoolIsAllowed(c: LogswapClient, poolId: Hex, who: Address): Promise<boolean> {
  return (await c.public.readContract({
    address: c.addresses.fPoolManager!,
    abi: fPoolManagerAbi,
    functionName: "allowed",
    args: [poolId, who],
  } as never)) as boolean;
}

/** Label the pool — the sponsor's own words, mutable, never identity. At most 31 bytes of UTF-8. */
export async function fPoolSetName(c: LogswapClient, a: { poolId: Hex; name: string; account: Address }) {
  return writeFPool(c, a.poolId, "setName", [textToBytes32(a.name)], a.account);
}

/**
 * What the PROTOCOL says an address is — "Keyrock". Only `feeCollector` may write it, which is
 * what makes it an attestation rather than a claim anyone could make about themselves.
 */
export async function fPoolSetSponsorName(c: LogswapClient, a: { who: Address; name: string; account: Address }) {
  const wallet = requireWallet(c);
  const { request } = await c.public.simulateContract({
    address: c.addresses.fPoolManager!,
    abi: fPoolManagerAbi,
    functionName: "setSponsorName",
    args: [a.who, textToBytes32(a.name)],
    account: a.account,
  } as never);
  return wallet.writeContract(request as never);
}

/** The protocol's attestation for an address, or "" when unattested — which most addresses are. */
export async function fPoolSponsorName(c: LogswapClient, who: Address): Promise<string> {
  const word = (await c.public.readContract({
    address: c.addresses.fPoolManager!,
    abi: fPoolManagerAbi,
    functionName: "sponsorName",
    args: [who],
  } as never)) as Hex;
  return bytes32ToText(word);
}

/** Appoint (or clear, with the zero address) the operator — the hot key that reshapes and never moves value out. */
export async function fPoolAppointOperator(c: LogswapClient, a: { poolId: Hex; operator: Address; account: Address }) {
  return writeFPool(c, a.poolId, "appointOperator", [a.operator], a.account);
}

/**
 * Set leg `j`'s liquidity (operator, sole LP only): grow, shrink, retire (`newLj = 0`), or re-admit
 * a retired leg holding `r` of the base (decisions 029 — the price follows, `p = newLj / r`; use
 * {@link fPoolReserveAt} from a mark). For a live leg leave `r` undefined — its price is the
 * market's, the reserve scales with the liquidity. Base moves single-sidedly through the lock;
 * shares adjust to hold the share value.
 */
export async function fPoolSetLegL(
  c: LogswapClient,
  a: { poolId: Hex; j: number; newLj: bigint; r?: bigint; account: Address },
) {
  return writeFPool(c, a.poolId, "setLegL", [BigInt(a.j), a.newLj, a.r ?? 0n], a.account);
}

/** Admit a base the pool has never held: `R` of it against liquidity `Lj`, so at `p = Lj / R` (operator, sole LP only). */
export async function fPoolAdmitLeg(
  c: LogswapClient,
  a: { poolId: Hex; base: Address; Lj: bigint; R: bigint; account: Address },
) {
  return writeFPool(c, a.poolId, "admitLeg", [a.base, a.Lj, a.R], a.account);
}

/**
 * Move shares (ERC-6909 `transfer`) — to another holder, or to `0xdead` to lock them for good.
 * Burning to the dead address is a sponsor's way to make its liquidity permanent: the shares can
 * never be redeemed, and they never count against the sole-LP precondition.
 */
export async function fPoolTransferShares(
  c: LogswapClient,
  a: { poolId: Hex; to: Address; shares: bigint; account: Address; gen?: bigint | number },
) {
  const wallet = requireWallet(c);
  const gen = a.gen ?? (await fPoolGen(c, a.poolId));
  const { request } = await c.public.simulateContract({
    address: c.addresses.fPoolManager!,
    abi: fPoolManagerAbi,
    functionName: "transfer",
    args: [a.to, fPoolShareId(a.poolId, gen), a.shares],
    account: a.account,
  } as never);
  return wallet.writeContract(request as never);
}

// ─── discovery from the log stream ────────────────────────────────────────────

export interface DiscoveredFPool {
  poolId: Hex;
  quote: Address;
  bases: Address[];
  weights: bigint[];
  phi: bigint;
  pad: boolean;
  authority: Address;
  /** The block the pool was initialized in — its age, for annualising realized income. */
  block: bigint;
  /** Whether `seed` has run; an unseeded pool has no floor and no float, so nothing to show. */
  seeded: boolean;
  /** The quote the pool was born with. Zero is the launchpad's signature (launchpad.md §3). */
  q0: bigint;
  /**
   * The PRODUCT the pool is, by the spec's definition rather than a guess: a LAUNCH is one asset
   * born at Q = 0 — a resting ask under a token, nothing raised, the creator alone on the lever;
   * everything else is a liquidity BASKET (public, quote-funded). Read from the Seeded log, so a
   * one-asset pool seeded WITH quote files correctly as liquidity, not as a pad.
   */
  shape: FPoolShape;
}

/**
 * Every F pool ever created, from `Initialize` logs alone. Possible only because the event
 * carries the full key preimage (bases, weights, phi, pad) — the poolId is a hash and could
 * never be inverted; contracts PR #17 exists for exactly this call.
 */
export async function discoverFPools(
  c: LogswapClient,
  opts: { fromBlock?: bigint; toBlock?: bigint } = {},
): Promise<DiscoveredFPool[]> {
  type Ev = Extract<(typeof fPoolManagerAbi)[number], { type: "event"; name: "Initialize" }>;
  const ev = fPoolManagerAbi.find((x): x is Ev => x.type === "event" && x.name === "Initialize");
  if (!ev) throw new Error("logswap: F Initialize event missing from the generated ABI");
  type SeedEv = Extract<(typeof fPoolManagerAbi)[number], { type: "event"; name: "Seeded" }>;
  const seedEv = fPoolManagerAbi.find((x): x is SeedEv => x.type === "event" && x.name === "Seeded");
  const [logs, seeds] = await Promise.all([
    c.public.getLogs({
      address: c.addresses.fPoolManager!,
      event: ev,
      fromBlock: opts.fromBlock ?? 0n,
      toBlock: opts.toBlock ?? "latest",
    }),
    seedEv
      ? c.public.getLogs({ address: c.addresses.fPoolManager!, event: seedEv, fromBlock: opts.fromBlock ?? 0n, toBlock: opts.toBlock ?? "latest" })
      : Promise.resolve([]),
  ]);
  const q0Of = new Map<string, bigint>();
  for (const l of seeds) {
    const a = l.args as { poolId: Hex; Q0: bigint };
    q0Of.set(a.poolId.toLowerCase(), a.Q0);
  }
  return logs.map((l) => {
    const a = l.args as {
      poolId: Hex; quote: Address; authority: Address; bases: readonly Address[];
      weights: readonly bigint[]; phi: bigint; pad: boolean;
    };
    const q0 = q0Of.get(a.poolId.toLowerCase());
    return {
      poolId: a.poolId,
      quote: a.quote,
      bases: [...a.bases],
      weights: [...a.weights],
      phi: a.phi,
      pad: a.pad,
      authority: a.authority,
      block: l.blockNumber ?? 0n,
      seeded: q0 !== undefined,
      q0: q0 ?? 0n,
      shape: a.bases.length === 1 && (q0 ?? 0n) === 0n ? "launch" : "basket",
    };
  });
}


/**
 * Every holder of a pool's shares, from the ERC-6909 Transfer stream — the id is an indexed
 * topic, so one filtered log query aggregates the whole ledger. The 0xdead entry is the
 * MIN_SHARES lock from seeding; callers usually label rather than hide it.
 */
export async function fPoolShareHolders(
  c: LogswapClient,
  poolIdHex: Hex,
  opts: { fromBlock?: bigint; gen?: bigint | number } = {},
): Promise<Array<{ holder: Address; shares: bigint }>> {
  type Ev = Extract<(typeof fPoolManagerAbi)[number], { type: "event"; name: "Transfer" }>;
  const ev = fPoolManagerAbi.find((x): x is Ev => x.type === "event" && x.name === "Transfer");
  if (!ev) throw new Error("logswap: 6909 Transfer event missing from the generated ABI");
  const id = fPoolShareId(poolIdHex, opts.gen ?? (await fPoolGen(c, poolIdHex)));
  const logs = await c.public.getLogs({
    address: c.addresses.fPoolManager!,
    event: ev,
    args: { id },
    fromBlock: opts.fromBlock ?? 0n,
    toBlock: "latest",
  });
  const bal = new Map<string, bigint>();
  for (const l of logs) {
    const a = l.args as { from: Address; to: Address; amount: bigint };
    if (a.from !== "0x0000000000000000000000000000000000000000") bal.set(a.from, (bal.get(a.from) ?? 0n) - a.amount);
    if (a.to !== "0x0000000000000000000000000000000000000000") bal.set(a.to, (bal.get(a.to) ?? 0n) + a.amount);
  }
  return [...bal.entries()]
    .filter(([, v]) => v > 0n)
    .map(([holder, shares]) => ({ holder: holder as Address, shares }))
    .sort((a, b) => (b.shares > a.shares ? 1 : -1));
}

/** Every F pool's state in one lens call (the raw manager struct: quote, phi, authority, pad, seeded, gen, n, Q, L, shares, theta0, bigSigma, harvestedTheta). */
export async function getFPoolsRaw(c: LogswapClient, poolIds: Hex[]): Promise<readonly unknown[]> {
  const { logswapLensAbi } = await import("./generated.js");
  return (await c.public.readContract({ address: c.addresses.lens, abi: logswapLensAbi, functionName: "getFPools", args: [poolIds] } as never)) as readonly unknown[];
}

/** Share value from the lens — (L + Q)/shares, WAD per share — the same figure as `fPoolShareValue`, from one source. */
export async function shareValueOnChain(c: LogswapClient, poolId: Hex): Promise<bigint> {
  const { logswapLensAbi } = await import("./generated.js");
  return (await c.public.readContract({ address: c.addresses.lens, abi: logswapLensAbi, functionName: "shareValue", args: [poolId] } as never)) as bigint;
}
