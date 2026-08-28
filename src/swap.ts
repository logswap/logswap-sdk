/**
 * swap.ts — trading.
 *
 * All four shapes go through the router, which is where slippage and deadline live. The manager's
 * merged `swap(key, baseSide, amount, limit)` uses a NEGATIVE amount for exact-out; that convention
 * is deliberately not exposed here — callers say `swapExactOut`.
 */

import type { Address, Hash } from "viem";
import { logswapLensAbi, logswapRouterAbi } from "./generated.js";
import type { LogswapClient } from "./client.js";
import type { PoolKey } from "./keys.js";
import { resolveDeadline, resolveRecipient, sendRouterWrite, type WriteOptions , sendRouterWriteWithPermits } from "./write.js";

/**
 * Quote an exact-in swap. Exact, not approximate — the lens is a revert-quoter that runs the real
 * swap and reverts with the result, so what it returns is what execution returns, bit for bit
 * (including the dynamic fee, even across a block boundary with the variance fold pending).
 *
 * `simulate`, not a plain read: the function is non-view by construction.
 */
export async function quoteExactIn(
  c: LogswapClient,
  key: PoolKey,
  baseIn: boolean,
  amountIn: bigint,
): Promise<bigint> {
  const { result } = await c.public.simulateContract({
    address: c.addresses.lens,
    abi: logswapLensAbi,
    functionName: "previewSwapExactIn",
    args: [key, baseIn, amountIn],
  });
  return result as bigint;
}

/** Quote an exact-out swap: how much input it will cost. Exact, same mechanism as above. */
export async function quoteExactOut(
  c: LogswapClient,
  key: PoolKey,
  baseOut: boolean,
  amountOut: bigint,
): Promise<bigint> {
  const { result } = await c.public.simulateContract({
    address: c.addresses.lens,
    abi: logswapLensAbi,
    functionName: "previewSwapExactOut",
    args: [key, baseOut, amountOut],
  });
  return result as bigint;
}

export interface SwapExactInArgs extends WriteOptions {
  key: PoolKey;
  /** true = base in, quote out (price falls). false = quote in, base out (price rises). */
  baseIn: boolean;
  amountIn: bigint;
  /** Reverts below this. Derive from a quote with `withSlippage(q, bps, "output")`. */
  minOut: bigint;
}

export async function swapExactIn(c: LogswapClient, a: SwapExactInArgs): Promise<Hash> {
  return sendRouterWriteWithPermits(c, {
    abi: logswapRouterAbi,
    functionName: "swapExactIn",
    args: [a.key, a.baseIn, a.amountIn, a.minOut, resolveRecipient(c, a), resolveDeadline(a)],
  }, [a.baseIn ? a.key.base : a.key.quote]);
}

export interface SwapExactOutArgs extends WriteOptions {
  key: PoolKey;
  /** true = base out (price rises). false = quote out (price falls). */
  baseOut: boolean;
  amountOut: bigint;
  /** Reverts above this. Derive from a quote with `withSlippage(q, bps, "input")`. */
  maxIn: bigint;
}

export async function swapExactOut(c: LogswapClient, a: SwapExactOutArgs): Promise<Hash> {
  return sendRouterWriteWithPermits(c, {
    abi: logswapRouterAbi,
    functionName: "swapExactOut",
    args: [a.key, a.baseOut, a.amountOut, a.maxIn, resolveRecipient(c, a), resolveDeadline(a)],
  }, [a.baseOut ? a.key.quote : a.key.base]);
}

/** One leg of a route. `baseIn` is that hop's direction through its own market. */
export interface Hop {
  key: PoolKey;
  baseIn: boolean;
}

export interface SwapPathArgs extends WriteOptions {
  hops: readonly Hop[];
  amountIn: bigint;
  minOut: bigint;
}

/**
 * Multi-hop, all inside ONE lock.
 *
 * The singleton dividend: deltas accrue per TOKEN across the whole route, so an intermediate asset
 * is never actually moved — a three-market route transfers only the tokens at the endpoints. The
 * path is not validated on-chain, and it does not need to be: a mis-chained hop leaves a dangling
 * delta and the lock refuses to close.
 */
export async function swapExactInPath(c: LogswapClient, a: SwapPathArgs): Promise<Hash> {
  if (a.hops.length === 0) throw new Error("logswap: empty path");
  return sendRouterWrite(c, {
    abi: logswapRouterAbi,
    functionName: "swapExactInPath",
    args: [
      a.hops.map((h) => ({ key: h.key, baseIn: h.baseIn })),
      a.amountIn,
      a.minOut,
      resolveRecipient(c, a),
      resolveDeadline(a),
    ],
  });
}

/**
 * Which token a hop takes in and pays out — the check a UI should run before building a route, so
 * a mis-chained path fails in the form rather than at the lock.
 */
export function hopTokens(h: Hop): { tokenIn: Address; tokenOut: Address } {
  return h.baseIn
    ? { tokenIn: h.key.base, tokenOut: h.key.quote }
    : { tokenIn: h.key.quote, tokenOut: h.key.base };
}

/** True when every hop's output feeds the next hop's input. */
export function isPathChained(hops: readonly Hop[]): boolean {
  for (let i = 1; i < hops.length; i++) {
    const prev = hopTokens(hops[i - 1]!);
    const next = hopTokens(hops[i]!);
    if (prev.tokenOut.toLowerCase() !== next.tokenIn.toLowerCase()) return false;
  }
  return true;
}
