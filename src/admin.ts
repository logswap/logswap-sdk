/**
 * admin — the protocol's (feeCollector's) writes: the protocol's cuts, the harvest-cut exemption,
 * and the two-step collector handover, on both managers. Plain writes to the managers; no router.
 * One vocabulary (decisions 040): both managers call the protocol's cut of the mint fee
 * `MINT_FEE_PROTOCOL_CUT` and set it through `setFeeParams` — one cut on C (since version 4,
 * decisions 042; `setProtocolFeeCut` / `PROTOCOL_FEE_CUT` before), two on F.
 */

import type { Address, Hash, Hex } from "viem";
import type { LogswapClient } from "./client.js";
import { cPoolManagerAbi, fPoolManagerAbi } from "./generated.js";

function wallet(c: LogswapClient) {
  if (!c.wallet) throw new Error("a wallet client is required");
  return c.wallet;
}

/** The C manager's `setFeeParams(mintFeeProtocolCut)` — one cut. */
export async function setFeeParamsC(c: LogswapClient, mintFeeProtocolCutWad: bigint): Promise<Hash> {
  return wallet(c).writeContract({ address: c.addresses.cPoolManager, abi: cPoolManagerAbi, functionName: "setFeeParams", args: [mintFeeProtocolCutWad], chain: c.wallet!.chain, account: c.wallet!.account! } as never);
}
/** The F manager's `setFeeParams(mintFeeProtocolCut, harvestProtocolCut)` — two cuts. */
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
