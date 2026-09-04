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
  /** `harvest` may not take Q/L under this (WAD log-distance); raise-only (decisions 021). */
  minBuffer: bigint;
  /** Only `allowed` accounts may receive minted shares. */
  gateMint: boolean;
  /** Only `allowed` takers may swap. */
  gateSwap: boolean;
  /** The block of the last lever / composition action: no swap runs in it. */
  restructureBlock: number;
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
    restructureBlock: number;
    gateMint: boolean;
    gateSwap: boolean;
    Q: bigint;
    L: bigint;
    shares: bigint;
    theta0: bigint;
    bigSigma: bigint;
    leverTheta: bigint;
    pendingAuthority: Address;
    operator: Address;
    minBuffer: bigint;
  }>("getPool", [poolId]);

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
  const x = legs.map((l) => l[2]);
  // the ISOLATION SHADOW, not the derived reserve: what this pool actually holds of the token.
  // In a singleton the contract's balance backs many pools, so this is the only per-pool figure.
  const reserves = legs.map((l) => l[3]);
  const { quote, Q, L, phi, theta0, bigSigma, authority, pendingAuthority, operator, minBuffer, gateMint, gateSwap, restructureBlock, feesOnly, seeded, dissolved } = p;
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
    minBuffer,
    gateMint,
    gateSwap,
    restructureBlock: Number(restructureBlock),
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

// ─── the floor lever (authority only) ─────────────────────────────────────────

/**
 * Remove quote, lifting θ — price-neutral, pro-rata, no base moves. Under `feesOnly` the lift
 * stops at θ₀, so the authority extracts income and never the proceeds backing the floor.
 */
export async function fPoolHarvest(c: LogswapClient, a: { poolId: Hex; amount: bigint; to?: Address; account: Address }) {
  return writeFPool(c, a.poolId, "harvest", [a.amount, a.to ?? a.account], a.account);
}

/** Commit quote, deepening θ — the other sign of `harvest`, the same word as the C floor edit (decisions 011). The mark does not move: governance may write θ, never x. */
export async function fPoolDeepen(c: LogswapClient, a: { poolId: Hex; amount: bigint; account: Address }) {
  return writeFPool(c, a.poolId, "deepen", [a.amount], a.account);
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
  /** true: the authority's harvest stops at the seed strike θ₀ (the launch posture). */
  feesOnly: boolean;
  authority: Address;
  account: Address;
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
  const key = { quote: a.quote, bases, weights: companions[0]!, phi: a.phi, feesOnly: a.feesOnly, authority: a.authority };
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
  const key = { quote: a.quote, bases, weights: companions[0]!, phi: a.phi, feesOnly: a.feesOnly, authority: a.authority };
  return c.public.readContract({
    address: c.addresses.fPoolManager!,
    abi: fPoolManagerAbi,
    functionName: "idOf",
    args: [key],
  } as never) as Promise<Hex>;
}

/**
 * Arm the pool: deposit the full basket at marks `x0` plus `Q0` of quote. Authority-only on-chain
 * (an open seed lets anyone front-run the creator for the strike). `x0` must align with the
 * SORTED bases — use {@link sortFPoolLegs} on (bases, weights, x0) together when building forms.
 */
export async function fPoolSeed(
  c: LogswapClient,
  a: { poolId: Hex; L0: bigint; x0: bigint[]; Q0: bigint; account: Address },
) {
  return writeFPool(c, a.poolId, "seed", [a.L0, a.x0, a.Q0], a.account);
}

/** End of life. Gated on-chain to the authority and to Q at dust (the raise is not abortable). */
export async function fPoolDissolve(c: LogswapClient, a: { poolId: Hex; account: Address }) {
  return writeFPool(c, a.poolId, "dissolve", [], a.account);
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

/** `setLegL`'s "keep the stored mark" sentinel — the only legal `x` for a live leg. */
export const NO_X = -(2n ** 255n);

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

/** Appoint (or clear, with the zero address) the operator — the hot key that reshapes and never moves value out. */
export async function fPoolAppointOperator(c: LogswapClient, a: { poolId: Hex; operator: Address; account: Address }) {
  return writeFPool(c, a.poolId, "appointOperator", [a.operator], a.account);
}

/**
 * Raise the floor guard: `harvest` may not take Q/L under `minBuffer` (WAD log-distance; 20% below
 * spot is ln 1.25 ≈ 0.223e18). Raise-only — a commitment the authority cannot walk back.
 */
export async function fPoolRaiseMinBuffer(c: LogswapClient, a: { poolId: Hex; minBuffer: bigint; account: Address }) {
  return writeFPool(c, a.poolId, "raiseMinBuffer", [a.minBuffer], a.account);
}

/**
 * Set leg `j`'s liquidity (operator, sole LP only): grow, shrink, retire (`newLj = 0`), or re-admit
 * a retired leg at a named mark `x`. For a live leg leave `x` undefined — its mark is the market's.
 * The base moves single-sidedly through the lock; shares adjust to hold the share value.
 */
export async function fPoolSetLegL(
  c: LogswapClient,
  a: { poolId: Hex; j: number; newLj: bigint; x?: bigint; account: Address },
) {
  return writeFPool(c, a.poolId, "setLegL", [BigInt(a.j), a.newLj, a.x ?? NO_X], a.account);
}

/** Admit a base the pool has never held, at a named mark, with liquidity `Lj` (operator, sole LP only). */
export async function fPoolAdmitLeg(
  c: LogswapClient,
  a: { poolId: Hex; base: Address; Lj: bigint; x: bigint; account: Address },
) {
  return writeFPool(c, a.poolId, "admitLeg", [a.base, a.Lj, a.x], a.account);
}

/**
 * Move shares (ERC-6909 `transfer`) — to another holder, or to `0xdead` to lock them for good.
 * Burning to the dead address is a sponsor's way to make its liquidity permanent: the shares can
 * never be redeemed, and they never count against the sole-LP precondition.
 */
export async function fPoolTransferShares(
  c: LogswapClient,
  a: { poolId: Hex; to: Address; shares: bigint; account: Address },
) {
  const wallet = requireWallet(c);
  const { request } = await c.public.simulateContract({
    address: c.addresses.fPoolManager!,
    abi: fPoolManagerAbi,
    functionName: "transfer",
    args: [a.to, fPoolShareId(a.poolId), a.shares],
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
  feesOnly: boolean;
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
 * carries the full key preimage (bases, weights, phi, feesOnly) — the poolId is a hash and could
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
      weights: readonly bigint[]; phi: bigint; feesOnly: boolean;
    };
    const q0 = q0Of.get(a.poolId.toLowerCase());
    return {
      poolId: a.poolId,
      quote: a.quote,
      bases: [...a.bases],
      weights: [...a.weights],
      phi: a.phi,
      feesOnly: a.feesOnly,
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
  opts: { fromBlock?: bigint } = {},
): Promise<Array<{ holder: Address; shares: bigint }>> {
  type Ev = Extract<(typeof fPoolManagerAbi)[number], { type: "event"; name: "Transfer" }>;
  const ev = fPoolManagerAbi.find((x): x is Ev => x.type === "event" && x.name === "Transfer");
  if (!ev) throw new Error("logswap: 6909 Transfer event missing from the generated ABI");
  const id = fPoolShareId(poolIdHex);
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

/** Every F pool's state in one lens call (the raw manager struct: quote, phi, authority, feesOnly, seeded, dissolved, n, Q, L, shares, theta0, bigSigma, leverTheta). */
export async function getFPoolsRaw(c: LogswapClient, poolIds: Hex[]): Promise<readonly unknown[]> {
  const { logswapLensAbi } = await import("./generated.js");
  return (await c.public.readContract({ address: c.addresses.lens, abi: logswapLensAbi, functionName: "getFPools", args: [poolIds] } as never)) as readonly unknown[];
}

/** Share value from the lens — (L + Q)/shares, WAD per share — the same figure as `fPoolShareValue`, from one source. */
export async function shareValueOnChain(c: LogswapClient, poolId: Hex): Promise<bigint> {
  const { logswapLensAbi } = await import("./generated.js");
  return (await c.public.readContract({ address: c.addresses.lens, abi: logswapLensAbi, functionName: "shareValue", args: [poolId] } as never)) as bigint;
}
