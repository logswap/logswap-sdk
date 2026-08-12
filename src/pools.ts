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

/**
 * A market's token decimals, read from the tokens themselves.
 *
 * **Never assume these.** A market's two tokens routinely differ (USDC 6 against WETH 18), the
 * manager itself probes `decimals()` to scale `minBackstopL`, and a token that does not implement
 * it falls back to 18. Hardcoding a guess makes every parse and every display wrong by orders of
 * magnitude while the contract behaves perfectly — which reads as "the app is broken".
 */
export async function marketDecimals(
  c: LogswapClient,
  key: PoolKey,
): Promise<{ base: number; quote: number }> {
  const abi = [
    { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  ] as const;
  const read = async (token: Address): Promise<number> => {
    try {
      return Number(await c.public.readContract({ address: token, abi, functionName: "decimals" }));
    } catch {
      return 18; // same fallback the manager uses when the token does not implement it
    }
  };
  const [base, quote] = await Promise.all([read(key.base), read(key.quote)]);
  return { base, quote };
}

/** A token as a UI needs it: address, symbol and decimals, all read from the chain. */
export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
}

/** Both sides of a market, for labelling and scaling. One call, four reads, cached by the caller. */
export async function marketTokens(
  c: LogswapClient,
  key: PoolKey,
): Promise<{ base: TokenInfo; quote: TokenInfo }> {
  const abi = [
    { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
    { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  ] as const;
  const read = async (address: Address): Promise<TokenInfo> => {
    const [decimals, symbol] = await Promise.all([
      c.public
        .readContract({ address, abi, functionName: "decimals" })
        .then(Number)
        .catch(() => 18),
      c.public
        .readContract({ address, abi, functionName: "symbol" })
        .then(String)
        .catch(() => address.slice(0, 6)),
    ]);
    return { address, symbol, decimals };
  };
  const [base, quote] = await Promise.all([read(key.base), read(key.quote)]);
  return { base, quote };
}

/** Format a quote-denominated amount for display, given the quote's decimals. */
export function formatQuote(amount: bigint, quoteDecimals: number): string {
  return formatUnits(amount, quoteDecimals);
}

// ---------------------------------------------------------------------------------------------
// Denominated readouts
//
// `F` and `lpEdge` are per unit of active L — dimensionless WAD fractions, not amounts. A
// dashboard wants amounts, and multiplying by L is the whole conversion. Keeping these here rather
// than in the app means one definition of "fees in quote" instead of one per screen.
// ---------------------------------------------------------------------------------------------

const WAD = 10n ** 18n;
const YEAR_SECONDS = 31_536_000n;

/** Fees the pool has accrued over its life, in QUOTE units: $F \cdot L$. */
export function feesQuote(state: Pick<PoolState, "F" | "lActive">): bigint {
  return (state.F * state.lActive) / WAD;
}

/** The LP edge in QUOTE units: $(F - \tfrac12\Sigma) \cdot L$. Signed. */
export function edgeQuote(state: Pick<PoolState, "F" | "bigSigma" | "lActive">): bigint {
  return (lpEdge(state) * state.lActive) / WAD;
}

/** The pool floor as a price. **Lossy** — display only, like {@link priceOf}. */
export function floorPrice(state: Pick<PoolState, "backstopFloor">): number {
  return Math.exp(Number(state.backstopFloor) / 1e18);
}

/** $\log(p / p_{\text{floor}}) = x - \xi$ — how far spot sits above the floor, in log units (WAD). */
export function floorDistance(state: Pick<PoolState, "x" | "backstopFloor">): bigint {
  return state.x - state.backstopFloor;
}

/**
 * $-\log(p/p_{\text{floor}})$ as a fraction: the log-drawdown from spot down to the floor.
 *
 * **Negative** while price is above the floor — it is how far price has to fall, so a UI can print
 * it with its sign and mean it. Zero at the floor.
 *
 * This is the LOG measure, not the arithmetic one: the actual price drawdown is
 * $e^{-\Delta} - 1$, which differs materially once the distance is large (a log distance of 0.7
 * is a 50% price fall, not 70%).
 */
export function floorDrawdown(state: Pick<PoolState, "x" | "backstopFloor">): number {
  return -Number(floorDistance(state)) / 1e18;
}

/** The arithmetic price drawdown to the floor, $p_{\text{floor}}/p - 1$. Negative above the floor. */
export function floorDrawdownPrice(state: Pick<PoolState, "x" | "backstopFloor">): number {
  return Math.exp(-Number(floorDistance(state)) / 1e18) - 1;
}

/**
 * Annualise a per-unit-L WAD rate over the window it accrued in.
 *
 * `F` is cumulative fee income per unit of exposure since the pool opened, so dividing by the
 * elapsed time and scaling to a year gives a rate directly — no price process assumed. Returns a
 * fraction: 0.12 is 12%.
 *
 * Treat it as what it is: a *realised* rate over one short devnet window, not a forecast.
 */
export function annualise(perUnitL: bigint, elapsedSeconds: bigint): number {
  if (elapsedSeconds <= 0n) return 0;
  return (Number(perUnitL) / 1e18) * (Number(YEAR_SECONDS) / Number(elapsedSeconds));
}

/** When a market was created, as a unix timestamp — the denominator for {@link annualise}. */
export async function marketOpenedAt(c: LogswapClient, m: DiscoveredMarket): Promise<bigint> {
  const b = await c.public.getBlock({ blockNumber: m.blockNumber });
  return b.timestamp;
}
