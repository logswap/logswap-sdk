/**
 * ids.ts — the ERC-6909 id namespace, computed OFFLINE.
 *
 * Two kinds of id share one ERC-6909 space, split on **bit 255**:
 *
 *   bit 255 SET    a position class:  (1 << 255) | (keccak256(poolId ‖ packed) >> 1)
 *   bit 255 CLEAR  a token claim:     uint160(tokenAddress)
 *
 * Both are **tier-1 frozen** (docs/app.md). The namespace bit is what lets a wallet UI, a lender, or
 * an indexer tell an LP position from a bearer IOU — and an indexer that ignores it will report
 * phantom LP positions for market makers parking inventory.
 */

import { concatHex, keccak256, pad, toHex, type Address, type Hex } from "viem";

/** Packing offset for the signed tick index `k`, so it fits an unsigned 32-bit field. */
const ID_OFFSET = 1n << 31n;
/** Sentinel meaning "no cap" — `type(int256).min`. */
export const NO_CAP = -(2n ** 255n);
const BIT_255 = 1n << 255n;

/**
 * `packed` — the class's (floor, cap) as two 32-bit fields: `kFloor + 2^31` in the low half,
 * `kCap + 2^31` in the high half, or zero there when uncapped.
 *
 * Throws on an off-grid floor or cap rather than producing an id the manager would reject, so a
 * client fails at the call site instead of at the transaction.
 */
export function packFloorCap(tickSpacing: bigint, floor: bigint, cap: bigint = NO_CAP): bigint {
  if (tickSpacing <= 0n) throw new Error("tickSpacing must be positive");
  if (floor % tickSpacing !== 0n) throw new Error(`floor ${floor} is off-grid for spacing ${tickSpacing}`);
  let packed = BigInt.asUintN(64, floor / tickSpacing + ID_OFFSET);
  if (cap !== NO_CAP) {
    if (cap <= floor) throw new Error("cap must be strictly above floor");
    if (cap % tickSpacing !== 0n) throw new Error(`cap ${cap} is off-grid for spacing ${tickSpacing}`);
    packed |= BigInt.asUintN(64, cap / tickSpacing + ID_OFFSET) << 32n;
  }
  return packed;
}

/** Inverse of {@link packFloorCap}. `capped === false` means the cap field is unset. */
export function unpackFloorCap(
  tickSpacing: bigint,
  packed: bigint,
): { floor: bigint; cap: bigint; capped: boolean } {
  const kf = (packed & 0xffffffffn) - ID_OFFSET;
  const hi = packed >> 32n;
  const capped = hi !== 0n;
  return { floor: kf * tickSpacing, cap: capped ? (hi - ID_OFFSET) * tickSpacing : NO_CAP, capped };
}

/**
 * The position-class id: `(1 << 255) | (keccak256(poolId ‖ packed) >> 1)`.
 *
 * The `>> 1` is what frees bit 255 for the namespace flag, so the hash contributes 255 bits.
 * `abi.encodePacked(bytes32, uint64)` is 40 bytes — 32 for the pool id, 8 for `packed`.
 */
export function positionId(poolId_: Hex, tickSpacing: bigint, floor: bigint, cap: bigint = NO_CAP): bigint {
  const packed = packFloorCap(tickSpacing, floor, cap);
  const h = BigInt(keccak256(concatHex([poolId_, pad(toHex(packed), { size: 8 })])));
  return BIT_255 | (h >> 1n);
}

/** A token claim's id is just the token address. */
export function claimId(token: Address): bigint {
  return BigInt(token);
}

/** True for a position class, false for a token claim. Split every 6909 `Transfer` on this. */
export function isPosition(id: bigint): boolean {
  return (id & BIT_255) !== 0n;
}

/** The token an id refers to, or `null` if the id is a position rather than a claim. */
export function claimToken(id: bigint): Address | null {
  if (isPosition(id)) return null;
  return pad(toHex(id), { size: 20 }) as Address;
}
