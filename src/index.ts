/**
 * Logswap SDK — typed, offline-first helpers over the CPoolManager / Router / Lens surface.
 *
 * The manager/router/lens split is an EIP-170 artifact, not a design boundary, so it is hidden
 * here: callers address markets by `PoolKey` and never choose a contract. A future re-homing of
 * a function is then an SDK patch rather than a breaking change (docs/app.md, tier 2).
 */
export * from "./keys.js";
export * from "./ids.js";
export * from "./client.js";
export * from "./pools.js";
export * from "./positions.js";
export * from "./write.js";
export * from "./swap.js";
export * from "./liquidity.js";
export * from "./claims.js";
export * from "./onboard.js";
export * from "./indexer.js";
export * from "./tokencache.js";
export * from "./fpool.js";
