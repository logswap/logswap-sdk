/**
 * The batch's payload encoders against vectors THE CONTRACT produced (`script/GenVectors.s.sol`,
 * the `actions` block): a client encodes an action offline, so if the TypeScript and the
 * Solidity ever disagree on a struct's shape the router decodes garbage. Same discipline as the
 * id derivation — the answers come from the chain's own `abi.encode`, never from this file.
 */

import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import vectors from "../vectors/derivation-vectors.json" with { type: "json" };
import { poolId, type PoolKey } from "../src/keys.js";
import { NO_CAP, positionId } from "../src/ids.js";
import {
  burnAction,
  claimAction,
  mintAction,
  Op,
  OPEN_DELTA,
  pathAction,
  settleInKind,
  settleOnly,
  swapExactInAction,
  updateAction,
} from "../src/actions.js";

const V = vectors as unknown as { vectors: Array<Record<string, string>>; actions: Record<string, `0x${string}`> };

// the generator's keys[0] and keys[1]
const K: PoolKey = {
  base: "0x1111111111111111111111111111111111111111",
  quote: "0x2222222222222222222222222222222222222222",
  tickSpacing: 10n ** 17n,
  phiMin: 3n * 10n ** 15n,
  kappa: 6267n * 10n ** 14n,
  alpha: 10n ** 16n,
};
const K2: PoolKey = {
  base: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  quote: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  tickSpacing: 10n ** 16n,
  phiMin: 0n,
  kappa: 0n,
  alpha: 0n,
};
const pid = poolId(K);
const id0 = positionId(pid, K.tickSpacing, 0n);
const id1 = positionId(pid, K.tickSpacing, 10n ** 17n, 90n * 10n ** 17n);

describe("action payloads equal the contract's abi.encode", () => {
  it("mint", () => {
    const a = mintAction({ key: K, targetFloor: -15n * 10n ** 17n, L: 123456789n * 10n ** 12n });
    expect(a.op).toBe(Op.MintBlended);
    expect(a.data).toBe(V.actions.mint);
  });
  it("burn", () => {
    expect(burnAction({ key: K, ids: [id0, id1], shares: [10n ** 18n, 2n * 10n ** 18n] }).data).toBe(V.actions.burn);
  });
  it("swap, with OPEN_DELTA as the amount", () => {
    expect(swapExactInAction({ key: K, baseIn: true, amountIn: OPEN_DELTA, minOut: 7n }).data).toBe(V.actions.swap);
  });
  it("claim", () => {
    expect(claimAction({ key: K, ids: [id0] }).data).toBe(V.actions.claim);
  });
  it("update", () => {
    expect(
      updateAction({ key: K, fromId: id0, shares: 5n * 10n ** 18n, toFloor: -(10n ** 17n), toCap: 90n * 10n ** 17n, newL: 42n * 10n ** 18n })
        .data,
    ).toBe(V.actions.update);
  });
  it("path, from an open delta", () => {
    expect(pathAction({ hops: [{ key: K, baseIn: true }, { key: K2, baseIn: false }], amountIn: OPEN_DELTA, minOut: 1n }).data).toBe(
      V.actions.path,
    );
  });
  it("the cap default is NO_CAP", () => {
    expect(mintAction({ key: K, targetFloor: 0n, L: 1n }).data).toBe(mintAction({ key: K, targetFloor: 0n, cap: NO_CAP, L: 1n }).data);
  });
});

describe("settlement builders", () => {
  const me = "0x000000000000000000000000000000000000dead" as Address;
  it("in kind binds both tokens, unbounded in / zero out by default", () => {
    const s = settleInKind(K, me, { minQuoteOut: 5n });
    expect(s.tokens).toEqual([K.base, K.quote]);
    expect(s.maxIn).toEqual([OPEN_DELTA, OPEN_DELTA]);
    expect(s.minOut).toEqual([0n, 5n]);
  });
  it("one side pins the other to zero both ways", () => {
    const s = settleOnly(K, me, "base", { maxIn: 3n, minOut: 2n });
    expect(s.maxIn).toEqual([3n, 0n]);
    expect(s.minOut).toEqual([2n, 0n]);
    const q = settleOnly(K, me, "quote");
    expect(q.maxIn).toEqual([0n, OPEN_DELTA]);
    expect(q.minOut).toEqual([0n, 0n]);
  });
});
