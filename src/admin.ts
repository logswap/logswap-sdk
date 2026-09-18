/**
 * admin — the protocol's (feeCollector's) writes: the protocol's cuts, the harvest-cut exemption,
 * and the two-step collector handover, on both managers. Plain writes to the managers; no router.
 * One vocabulary (decisions 040): the C manager's `setProtocolFeeCut` / `PROTOCOL_FEE_CUT` are the
 * same words as F's `setFeeParams` / `MINT_FEE_PROTOCOL_CUT` until C version 4 renames them.
 */

import type { Address, Hash, Hex } from "viem";
import type { LogswapClient } from "./client.js";
import { cPoolManagerAbi, fPoolManagerAbi } from "./generated.js";

function wallet(c: LogswapClient) {
  if (!c.wallet) throw new Error("a wallet client is required");
  return c.wallet;
}

export async function setProtocolFeeCut(c: LogswapClient, cutWad: bigint): Promise<Hash> {
  return wallet(c).writeContract({ address: c.addresses.cPoolManager, abi: cPoolManagerAbi, functionName: "setProtocolFeeCut", args: [cutWad], chain: c.wallet!.chain, account: c.wallet!.account! } as never);
}
export async function setFeeParams(c: LogswapClient, mintFeeProtocolCutWad: bigint, harvestProtocolCutWad: bigint): Promise<Hash> {
  return wallet(c).writeContract({ address: c.addresses.fPoolManager as Address, abi: fPoolManagerAbi, functionName: "setFeeParams", args: [mintFeeProtocolCutWad, harvestProtocolCutWad], chain: c.wallet!.chain, account: c.wallet!.account! } as never);
}
/** Waive the protocol's cut of harvested income for one pool (`HARVEST_PROTOCOL_CUT`; F version 13 — `setHarvestFeeExempt` before). */
export async function setHarvestCutExempt(c: LogswapClient, poolId: Hex, exempt: boolean): Promise<Hash> {
  return wallet(c).writeContract({ address: c.addresses.fPoolManager as Address, abi: fPoolManagerAbi, functionName: "setHarvestCutExempt", args: [poolId, exempt], chain: c.wallet!.chain, account: c.wallet!.account! } as never);
}
export async function proposeCollector(c: LogswapClient, side: "C" | "F", next: Address): Promise<Hash> {
  const address = side === "C" ? c.addresses.cPoolManager : (c.addresses.fPoolManager as Address);
  const abi = side === "C" ? cPoolManagerAbi : fPoolManagerAbi;
  return wallet(c).writeContract({ address, abi, functionName: "proposeCollector", args: [next], chain: c.wallet!.chain, account: c.wallet!.account! } as never);
}
export async function acceptCollector(c: LogswapClient, side: "C" | "F"): Promise<Hash> {
  const address = side === "C" ? c.addresses.cPoolManager : (c.addresses.fPoolManager as Address);
  const abi = side === "C" ? cPoolManagerAbi : fPoolManagerAbi;
  return wallet(c).writeContract({ address, abi, functionName: "acceptCollector", args: [], chain: c.wallet!.chain, account: c.wallet!.account! } as never);
}
