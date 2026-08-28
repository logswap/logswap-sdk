/**
 * indexer.ts — reads the rindexer GraphQL that state cannot answer.
 *
 * The division of labour matters and is not arbitrary: **the indexer enumerates, the chain
 * values.** ERC-6909 has no enumeration, so there is no way to ask a node "which positions exist in
 * this pool" — only the `IdRegistered` log knows. But an indexed row is a historical fact, and `L`
 * changes with every mint, burn and harvest afterwards. So ids come from here and the current `L`
 * is read on-chain, rather than trusting a number that was true at index time.
 */

import type { Address, Hex } from "viem";
import type { LogswapClient } from "./client.js";
import { cPoolManagerAbi } from "./generated.js";
import { getPositionClass } from "./positions.js";
import { discoverMarkets, type DiscoveredMarket } from "./pools.js";
import { poolId, type PoolKey } from "./keys.js";

export interface IndexerError {
  message: string;
}

/**
 * A `bytea` column renders as `0x…` but FILTERS as `\x…`.
 *
 * Passing back the exact value the API just gave you returns zero rows, with no error — the query
 * is valid, the comparison simply never matches. Every filter on a hash goes through here.
 *
 * The result is passed as a **variable**, never interpolated into query text: `\x` is not a legal
 * escape inside a GraphQL string literal, so an interpolated filter fails with
 * `Syntax Error: Invalid character escape sequence`. Variables carry the value untouched.
 */
export function bytea(hex: Hex): string {
  return `\\x${hex.replace(/^0x/, "")}`;
}

export async function gql<T>(
  url: string,
  query: string,
  variables?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal,
  });
  if (!res.ok) throw new Error(`indexer: HTTP ${res.status} from ${url}`);
  const body = (await res.json()) as { data?: T; errors?: IndexerError[] };
  if (body.errors?.length) throw new Error(`indexer: ${body.errors.map((e) => e.message).join("; ")}`);
  if (!body.data) throw new Error("indexer: empty response");
  return body.data;
}

/** A position class as the chain registered it: the floor/cap geometry, fixed for the id's life. */
export interface RegisteredId {
  id: bigint;
  floor: bigint;
  cap: bigint;
  capped: boolean;
}

/** Every position class ever registered in a pool. Historical — some may since have burnt to zero. */
export async function registeredIds(url: string, poolId: Hex, signal?: AbortSignal): Promise<RegisteredId[]> {
  const q = `query Ids($pool: String!) {
    allIdRegistereds(condition: {poolId: $pool}, first: 1000) { nodes { id floor cap capped } }
  }`;
  const d = await gql<{ allIdRegistereds: { nodes: { id: string; floor: string; cap: string; capped: boolean }[] } }>(
    url,
    q,
    { pool: bytea(poolId) },
    signal,
  );
  return d.allIdRegistereds.nodes.map((n) => ({
    id: BigInt(n.id),
    floor: BigInt(n.floor),
    cap: BigInt(n.cap),
    capped: n.capped,
  }));
}

export interface PoolPosition extends RegisteredId {
  /** Total exposure across every holder, read from the chain — not from the indexed row. */
  L: bigint;
  shares: bigint;
  /** Spot is inside this position's range, so it is earning fees. */
  active: boolean;
}

/**
 * Every live position class in a pool, split by whether it is earning.
 *
 * A position is **active** when spot sits at or above its floor and, if capped, below its cap —
 * the same condition the tick ladder applies when it steps `lActive`.
 *
 * Classes that have burnt to `L = 0` are dropped: they are registered forever, but a list of
 * positions should show positions, not the history of ones that existed.
 */
export async function poolPositions(
  c: LogswapClient,
  url: string,
  poolId: Hex,
  x: bigint,
  signal?: AbortSignal,
): Promise<PoolPosition[]> {
  const ids = await registeredIds(url, poolId, signal);
  const rows = await Promise.all(
    ids.map(async (r) => {
      const cls = await getPositionClass(c, r.id);
      return { ...r, L: cls.L, shares: cls.shares, active: x >= r.floor && (!r.capped || x < r.cap) };
    }),
  );
  return rows.filter((r) => r.L > 0n).sort((a, b) => (b.L > a.L ? 1 : b.L < a.L ? -1 : 0));
}

/** Is the indexer answering? Used to degrade a screen rather than fail it. */
export async function indexerHealthy(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await gql(url, "{ __typename }", undefined, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Markets, from the indexer rather than a log scan.
 *
 * `discoverMarkets` reads `Initialize` logs straight from the node, which is correct until the node
 * stops keeping them. anvil's `--prune-history` drops historical transactions and receipts beyond a
 * window, so on a devnet that mines steadily the deployment's own logs age out and a scan from
 * block 0 returns nothing — while the contracts remain perfectly alive. Any real chain has the same
 * shape in a different form: archive-depth `getLogs` is exactly what public RPCs refuse.
 *
 * An indexer does not have that problem, because it recorded the event when it happened. This is
 * the more durable path and should be preferred wherever an indexer is configured, with the log
 * scan as the fallback for when it is not.
 *
 * `Initialize` carries every field of the `PoolKey`, so the key is rebuilt exactly and `poolId` is
 * recomputed locally rather than trusted from the row — the same offline derivation the SDK uses
 * everywhere else, so a wrong id fails loudly instead of addressing the wrong pool.
 */
export async function discoverMarketsIndexed(url: string, signal?: AbortSignal): Promise<DiscoveredMarket[]> {
  const q = `{ allInitializes(first: 1000) { nodes {
    poolId base quote tickSpacing phiMin kappa alpha x0 blockNumber txHash
  } } }`;
  type Row = {
    poolId: Hex; base: Hex; quote: Hex; tickSpacing: string; phiMin: string;
    kappa: string; alpha: string; x0: string; blockNumber: string; txHash: Hex;
  };
  const d = await gql<{ allInitializes: { nodes: Row[] } }>(url, q, undefined, signal);
  return d.allInitializes.nodes.map((n) => {
    const key: PoolKey = {
      base: n.base as Address,
      quote: n.quote as Address,
      tickSpacing: BigInt(n.tickSpacing),
      phiMin: BigInt(n.phiMin),
      kappa: BigInt(n.kappa),
      alpha: BigInt(n.alpha),
    };
    return {
      key,
      poolId: poolId(key),
      x0: BigInt(n.x0),
      blockNumber: BigInt(n.blockNumber),
      transactionHash: n.txHash,
    };
  });
}

/**
 * Markets, preferring the indexer and falling back to a log scan.
 *
 * The order matters: the indexer is authoritative for history, the node is authoritative for state.
 * A market the node can no longer tell you about is still a market.
 */
export async function discoverMarketsBest(
  c: LogswapClient,
  url: string | undefined,
  signal?: AbortSignal,
): Promise<{ markets: DiscoveredMarket[]; source: "indexer" | "chain" }> {
  if (url) {
    try {
      const markets = await discoverMarketsIndexed(url, signal);
      // The indexer is a CACHE and the chain is the truth. After a redeploy the indexer keeps
      // serving the previous deployment's markets; calling the new manager with those keys makes
      // every read revert, refresh-proof (it presented as "phiEff reverted", forever). So verify
      // each candidate against the manager the client is actually pointed at, and keep only the
      // markets that exist there; if none survive, the chain scan is the answer.
      if (markets.length) {
        const alive = (
          await Promise.all(
            markets.map(async (m) => {
              try {
                await c.public.readContract({
                  address: c.addresses.cPoolManager,
                  abi: cPoolManagerAbi,
                  functionName: "phiEff",
                  args: [m.key],
                } as never);
                return m;
              } catch {
                return null;
              }
            }),
          )
        ).filter((m): m is DiscoveredMarket => m !== null);
        if (alive.length) return { markets: alive, source: "indexer" };
      }
    } catch {
      /* fall through — a missing indexer must not cost you the market list */
    }
  }
  return { markets: await discoverMarkets(c), source: "chain" };
}
