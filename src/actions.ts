/**
 * actions.ts — the router's transaction: a BATCH (decisions 010).
 *
 * `execute(actions, settle)` runs a list of actions — mint, burn, update, claim, swap, path, in any
 * order, across any C markets — under ONE manager lock. Each action accrues deltas on the router
 * and settles nothing; the batch settles once per token in `settle.tokens`, pulling at most
 * `maxIn[i]` from the caller and taking at least `minOut[i]` to the recipient. A touched token
 * left off the list fails the manager's own close (`TokensNotSettled`), so the list is also the
 * caller's statement of which tokens may move.
 *
 * `OPEN_DELTA` as a swap amount means "the router's open delta of that token": what earlier
 * actions left it holding (exact-in, path) or owing (exact-out). It is what lets action i+1
 * consume action i's proceeds — a harvest funds a buy, a burn exits to one asset, a deepen is paid
 * in base — each moving ONE token.
 *
 * Payloads are `abi.encode` of the router's `*Act` structs. Their tuple types are read from the
 * generated ABI (the router's pure `encode*` helpers exist for exactly this), so nothing here is
 * hand-written and a struct change is a `tsc`/vector failure, not a runtime surprise.
 */

import { encodeAbiParameters, type Address, type Hash, type Hex } from "viem";
import { logswapRouterAbi } from "./generated.js";
import type { LogswapClient } from "./client.js";
import type { PoolKey } from "./keys.js";
import { NO_CAP } from "./ids.js";
import type { Hop } from "./swap.js";
import { resolveDeadline, resolveRecipient, sendRouterWriteWithPermits, simulateRouterWrite, type WriteOptions } from "./write.js";

/** "The router's open delta of that token" — the swap-amount sentinel. `type(uint256).max`. */
export const OPEN_DELTA = (1n << 256n) - 1n;
/** No bound. The same word as the sentinel, kept apart because it means something else. */
export const UNBOUNDED = (1n << 256n) - 1n;

/** The router's op tags — `OpType` in `RouterOps.sol`, C actions only (the F ops have their own lock). */
export enum Op {
  MintBlended = 0,
  Burn = 1,
  SwapExactIn = 2,
  SwapExactOut = 3,
  Claim = 4,
  Update = 5,
  Path = 6,
}

export interface Action {
  op: Op;
  data: Hex;
}

export interface Settle {
  tokens: readonly Address[];
  maxIn: readonly bigint[];
  minOut: readonly bigint[];
  /** Receives whatever is taken, and the shares the actions mint. */
  recipient: Address;
}

/* payload encoding ========================================================== */

function payloadType(encoder: string) {
  const f = (logswapRouterAbi as readonly { type: string; name?: string; inputs?: readonly unknown[] }[]).find(
    (x) => x.type === "function" && x.name === encoder,
  );
  if (!f?.inputs) throw new Error(`logswap: the router ABI has no ${encoder} — SDK and contracts disagree`);
  return f.inputs;
}

const enc = (encoder: string, value: unknown): Hex => encodeAbiParameters(payloadType(encoder) as never, [value] as never);

/** Mint exposure `L` at `targetFloor` (off-grid blends the two adjacent rungs), `cap` optional. */
export function mintAction(a: { key: PoolKey; targetFloor: bigint; cap?: bigint; L: bigint }): Action {
  return { op: Op.MintBlended, data: enc("encodeMint", { key: a.key, targetFloor: a.targetFloor, cap: a.cap ?? NO_CAP, L: a.L }) };
}

/** Burn `shares[i]` of `ids[i]`; accrued fees are swept into the same batch. Needs the operator grant. */
export function burnAction(a: { key: PoolKey; ids: readonly bigint[]; shares: readonly bigint[] }): Action {
  if (a.ids.length !== a.shares.length) throw new Error("logswap: ids and shares length mismatch");
  return { op: Op.Burn, data: enc("encodeBurn", { key: a.key, ids: a.ids, shares: a.shares }) };
}

/** Exact-in swap. `amountIn` may be `OPEN_DELTA`: the input an earlier action left the router holding. */
export function swapExactInAction(a: { key: PoolKey; baseIn: boolean; amountIn: bigint; minOut?: bigint }): Action {
  return { op: Op.SwapExactIn, data: enc("encodeSwap", { key: a.key, baseSide: a.baseIn, amount: a.amountIn, limit: a.minOut ?? 0n }) };
}

/** Exact-out swap. `amountOut` may be `OPEN_DELTA`: the output an earlier action left the router owing. */
export function swapExactOutAction(a: { key: PoolKey; baseOut: boolean; amountOut: bigint; maxIn?: bigint }): Action {
  return {
    op: Op.SwapExactOut,
    data: enc("encodeSwap", { key: a.key, baseSide: a.baseOut, amount: a.amountOut, limit: a.maxIn ?? UNBOUNDED }),
  };
}

/** Collect the caller's fees on `ids`; positions untouched. */
export function claimAction(a: { key: PoolKey; ids: readonly bigint[] }): Action {
  return { op: Op.Claim, data: enc("encodeClaim", { key: a.key, ids: a.ids }) };
}

/** The general edit — set `shares` of `fromId` to (`toFloor`, `toCap`, `newL`); `newL = 0` exits. */
export function updateAction(a: {
  key: PoolKey;
  fromId: bigint;
  shares: bigint;
  toFloor: bigint;
  toCap?: bigint;
  newL: bigint;
}): Action {
  return {
    op: Op.Update,
    data: enc("encodeUpdate", {
      key: a.key,
      fromId: a.fromId,
      shares: a.shares,
      toFloor: a.toFloor,
      toCap: a.toCap ?? NO_CAP,
      newL: a.newL,
    }),
  };
}

/** Multi-hop exact-in route; `amountIn` may be `OPEN_DELTA`. Intermediate tokens never move. */
export function pathAction(a: { hops: readonly Hop[]; amountIn: bigint; minOut?: bigint }): Action {
  if (a.hops.length === 0) throw new Error("logswap: empty path");
  return { op: Op.Path, data: enc("encodePath", { hops: a.hops, amountIn: a.amountIn, minOut: a.minOut ?? 0n }) };
}

/* settlement builders ======================================================= */

/** A settlement over explicit tokens; missing bounds default to unbounded in, zero out. */
export function settlement(a: {
  tokens: readonly Address[];
  maxIn?: readonly bigint[];
  minOut?: readonly bigint[];
  recipient: Address;
}): Settle {
  const n = a.tokens.length;
  const maxIn = a.maxIn ?? a.tokens.map(() => UNBOUNDED);
  const minOut = a.minOut ?? a.tokens.map(() => 0n);
  if (maxIn.length !== n || minOut.length !== n) throw new Error("logswap: settlement bounds length mismatch");
  return { tokens: a.tokens, maxIn, minOut, recipient: a.recipient };
}

export interface PairBounds {
  maxBaseIn?: bigint;
  maxQuoteIn?: bigint;
  minBaseOut?: bigint;
  minQuoteOut?: bigint;
}

/** Settle both of a market's tokens, in kind. */
export function settleInKind(key: PoolKey, recipient: Address, b: PairBounds = {}): Settle {
  return settlement({
    tokens: [key.base, key.quote],
    maxIn: [b.maxBaseIn ?? UNBOUNDED, b.maxQuoteIn ?? UNBOUNDED],
    minOut: [b.minBaseOut ?? 0n, b.minQuoteOut ?? 0n],
    recipient,
  });
}

/**
 * Settle in ONE of a market's tokens: the other is bound to zero both ways, so the batch must have
 * netted it — which is what a trailing `OPEN_DELTA` swap does.
 */
export function settleOnly(key: PoolKey, recipient: Address, side: "base" | "quote", b: { maxIn?: bigint; minOut?: bigint } = {}): Settle {
  const base = side === "base";
  return settlement({
    tokens: [key.base, key.quote],
    maxIn: [base ? (b.maxIn ?? UNBOUNDED) : 0n, base ? 0n : (b.maxIn ?? UNBOUNDED)],
    minOut: [base ? (b.minOut ?? 0n) : 0n, base ? 0n : (b.minOut ?? 0n)],
    recipient,
  });
}

/* the batch ================================================================= */

export interface ExecuteArgs extends WriteOptions {
  actions: readonly Action[];
  settle: Omit<Settle, "recipient"> & { recipient?: Address };
  /** Tokens the batch may pull, for the Permit2 signatures. Defaults to every token with `maxIn > 0`. */
  pullTokens?: readonly Address[];
}

/** Run a batch: one lock, one settlement per token, one transaction (Permit2 signatures ride inside). */
export async function execute(c: LogswapClient, a: ExecuteArgs): Promise<Hash> {
  const settle: Settle = { ...a.settle, recipient: a.settle.recipient ?? resolveRecipient(c, a) };
  const pull = a.pullTokens ?? settle.tokens.filter((_, i) => settle.maxIn[i]! > 0n);
  return sendRouterWriteWithPermits(
    c,
    { abi: logswapRouterAbi, functionName: "execute", args: [a.actions, settle, resolveDeadline(a)] },
    [...pull],
  );
}

/** Simulate a batch: the per-action returns and the signed flows (+ = paid in), without sending. */
export async function simulateExecute(
  c: LogswapClient,
  a: ExecuteArgs & { account?: Address },
): Promise<{ results: readonly Hex[]; flows: readonly bigint[] }> {
  const settle: Settle = { ...a.settle, recipient: a.settle.recipient ?? a.account ?? resolveRecipient(c, a) };
  const [results, flows] = await simulateRouterWrite<readonly [readonly Hex[], readonly bigint[]]>(c, {
    abi: logswapRouterAbi,
    functionName: "execute",
    args: [a.actions, settle, resolveDeadline(a)],
    account: a.account,
  });
  return { results, flows };
}
