/**
 * pools.ts — market state and discovery.
 *
 * Two things worth knowing before reading further.
 *
 * **Markets are discovered from logs, not configuration.** `Initialize` carries the ENTIRE
 * `PoolKey` in the clear, so a client can reconstruct any market's key — and therefore call any
 * keyed function — having never been told the market exists. There is no registry to maintain.
 *
 * **`x` is the state, price is derived.** The contract stores $x = \log p$ and materialises the
 * price only where unavoidable; `priceOf` below mirrors that, and is lossy in the way any float
 * conversion is. Prefer comparing in log space when precision matters.
 */

import { formatUnits, type Address, type Hex } from "viem";
import { logswapLensAbi, logswapManagerAbi } from "./generated.js";
import type { LogswapClient } from "./client.js";
import { poolId, type PoolKey } from "./keys.js";

/** The manager's `getPool` view, decoded. Field-for-field with `PoolView` in the contract. */
export interface PoolState {
  initialized: boolean;
  backstopSeeded: boolean;
  /** $x = \log p$, WAD — the stored state. */
  x: bigint;
  /** Exposure currently earning. Steps only when a floor or cap is crossed. */
  lActive: bigint;
  reserveBase: bigint;
  reserveQuote: bigint;
  /** Fee-per-unit-L accumulator: $\phi \cdot \mathrm{TV}(\log p)$. */
  F: bigint;
  /** Quadratic variation of log-price, $\Sigma = \int (dx)^2$. */
  bigSigma: bigint;
  sigma2Ema: bigint;
  currentK: bigint;
  protocolOwed: bigint;
  minBackstopL: bigint;
  backstopFloor: bigint;
}

/** Read a market's full state by key. */
export async function getPool(c: LogswapClient, key: PoolKey): Promise<PoolState> {
  const v = await c.public.readContract({
    address: c.addresses.manager,
    abi: logswapManagerAbi,
    functionName: "getPool",
    args: [poolId(key)],
  });
  return v as unknown as PoolState;
}

/** The effective fee right now: $\max(\phi_{\min}, \kappa\sqrt{\sigma^2_{\text{ema}}})$, capped. */
export async function phiEff(c: LogswapClient, key: PoolKey): Promise<bigint> {
  return c.public.readContract({
    address: c.addresses.manager,
    abi: logswapManagerAbi,
    functionName: "phiEff",
    args: [key],
  }) as Promise<bigint>;
}

/**
 * Price from the stored log-price. **Lossy** — `x` is exact and this is a float, so use it for
 * display and never for arithmetic you intend to send back on-chain.
 */
export function priceOf(state: Pick<PoolState, "x">): number {
  return Math.exp(Number(state.x) / 1e18);
}

/**
 * The model-free LP edge, $F - \tfrac12\Sigma$ — the protocol's headline metric, in quote per unit
 * of exposure.
 *
 * $F$ is fee income per unit active $L$; $\Sigma$ is the realised quadratic variation, whose half
 * is the LVR a log pool pays. The difference is what an LP actually earns, with no model of the
 * price process assumed. Both ride on every `Swap` event, so this is reconstructible from logs
 * alone (docs/app.md) — no state read needed if you are already indexing.
 *
 * Signed: negative means variation has outrun fee income over the pool's life.
 */
export function lpEdge(state: Pick<PoolState, "F" | "bigSigma">): bigint {
  return state.F - state.bigSigma / 2n;
}

/** A market discovered from an `Initialize` log — the full key, plus where it was created. */
export interface DiscoveredMarket {
  key: PoolKey;
  poolId: Hex;
  /** The market's opening log-price. */
  x0: bigint;
  blockNumber: bigint;
  transactionHash: Hex;
}

/**
 * Enumerate markets from `Initialize` logs.
 *
 * This is the whole market registry: the event carries every key field rather than just the id,
 * deliberately, so nothing downstream needs a configured list. Pass `fromBlock` as the manager's
 * deployment block — scanning from genesis is slow and pointless.
 */
export async function discoverMarkets(
  c: LogswapClient,
  opts: { fromBlock?: bigint; toBlock?: bigint; base?: Address; quote?: Address } = {},
): Promise<DiscoveredMarket[]> {
  // Narrow the const ABI to the Initialize entry while KEEPING its literal type, so viem can infer
  // the log shape. `as never` would compile but collapse every arg to `never` at the call site.
  type Ev = Extract<(typeof logswapManagerAbi)[number], { type: "event"; name: "Initialize" }>;
  const ev = logswapManagerAbi.find((x): x is Ev => x.type === "event" && x.name === "Initialize");
  if (!ev) throw new Error("logswap: Initialize event missing from the generated ABI");

  const logs = await c.public.getLogs({
    address: c.addresses.manager,
    event: ev,
    args: { base: opts.base, quote: opts.quote },
    fromBlock: opts.fromBlock ?? 0n,
    toBlock: opts.toBlock ?? "latest",
  });

  return logs.map((l) => {
    const a = l.args;
    const key: PoolKey = {
      base: a.base!,
      quote: a.quote!,
      tickSpacing: a.tickSpacing!,
      phiMin: a.phiMin!,
      kappa: a.kappa!,
      alpha: a.alpha!,
    };
    return {
      key,
      poolId: poolId(key),
      x0: a.x0!,
      blockNumber: l.blockNumber!,
      transactionHash: l.transactionHash!,
    };
  });
}

/**
 * Ladder shape: the live FLOORS, in log-price WAD — **not** tick indices.
 *
 * Named `liveFloors` deliberately. The lens function it wraps is called `liveTicks`, which reads as
 * if it returns `k`; it returns `k * tickSpacing`. Multiplying by the spacing again yields an
 * off-grid value and an `OffGrid` revert at the next call, which is a confusing place to discover
 * the mistake.
 */
export async function liveFloors(c: LogswapClient, key: PoolKey): Promise<readonly bigint[]> {
  return c.public.readContract({
    address: c.addresses.lens,
    abi: logswapLensAbi,
    functionName: "liveTicks",
    args: [key],
  }) as Promise<readonly bigint[]>;
}

/** Is this floor on the market's grid, and inside `MAX_ABS_FLOOR`? Pure — no RPC on the manager. */
export async function isValidFloor(c: LogswapClient, key: PoolKey, floor: bigint): Promise<boolean> {
  return c.public.readContract({
    address: c.addresses.lens,
    abi: logswapLensAbi,
    functionName: "isValidFloor",
    args: [key, floor],
  }) as Promise<boolean>;
}

/** Format a quote-denominated amount for display, given the quote's decimals. */
export function formatQuote(amount: bigint, quoteDecimals: number): string {
  return formatUnits(amount, quoteDecimals);
}
