/**
 * onboard.ts — getting a wallet to the point where router writes actually work.
 *
 * There are **three separate approvals** with three separate failure modes, and a UI that surfaces
 * them late produces failed transactions instead of prompts:
 *
 *   1. ERC-20 → Permit2      once per token, forever. Only when the router is Permit2-wired.
 *   2. Permit2 → router      a standing allowance, by transaction or by signature.
 *   3. 6909 operator grant   once per wallet, covers every market. Needed by burn/update/move.
 *
 * **The trap this module exists for:** when the router is deployed with Permit2, approving the
 * ERC-20 to the *router* is not enough and not used — the pull goes through Permit2, and the
 * failure is `NotAllowed()` from Permit2 rather than anything naming an allowance. Approving the
 * router directly looks correct and does nothing.
 */

import { parseAbi, zeroAddress, type Address, type Hash } from "viem";
import type { LogswapClient } from "./client.js";
import { requireWallet } from "./write.js";

export const MAX_UINT256 = (1n << 256n) - 1n;
export const MAX_UINT160 = (1n << 160n) - 1n;
export const MAX_UINT48 = (1n << 48n) - 1n;

const ERC20 = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const PERMIT2 = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function transferFrom(address from, address to, uint160 amount, address token)",
]);

/** Is this deployment's router wired to Permit2? Decides which approval path applies. */
export function usesPermit2(c: LogswapClient): boolean {
  return !!c.addresses.permit2 && c.addresses.permit2 !== zeroAddress;
}

/** The contract that will actually pull tokens: Permit2 when wired, otherwise the router. */
export function spenderFor(c: LogswapClient): Address {
  return usesPermit2(c) ? c.addresses.permit2! : c.addresses.router;
}

/** Step 1 — approve the *puller* on an ERC-20. Once per token. */
export async function approveToken(
  c: LogswapClient,
  token: Address,
  amount: bigint = MAX_UINT256,
): Promise<Hash> {
  const { account } = requireWallet(c);
  return c.wallet!.writeContract({
    address: token,
    abi: ERC20,
    functionName: "approve",
    args: [spenderFor(c), amount],
    account,
    chain: c.wallet!.chain,
  } as never);
}

/**
 * Step 2 — the standing Permit2 allowance for the router.
 *
 * No-op when the deployment has no Permit2. Prefer the signature flow (`applyPermit2` on the
 * router, bundled through `multicall`) in production; this transaction form is what a test or a
 * simple UI wants.
 */
export async function approvePermit2ForRouter(
  c: LogswapClient,
  token: Address,
  amount: bigint = MAX_UINT160,
  expiration: bigint = MAX_UINT48,
): Promise<Hash | null> {
  if (!usesPermit2(c)) return null;
  const { account } = requireWallet(c);
  return c.wallet!.writeContract({
    address: c.addresses.permit2!,
    abi: PERMIT2,
    functionName: "approve",
    args: [token, c.addresses.router, amount, Number(expiration)],
    account,
    chain: c.wallet!.chain,
  } as never);
}

/**
 * Both token-side steps in order, skipping any already satisfied.
 *
 * Returns the hashes actually sent, so a UI can report "2 approvals" honestly rather than always
 * prompting twice.
 */
export async function onboardToken(c: LogswapClient, token: Address, need: bigint): Promise<Hash[]> {
  const { account } = requireWallet(c);
  const sent: Hash[] = [];

  const allowance = (await c.public.readContract({
    address: token,
    abi: ERC20,
    functionName: "allowance",
    args: [account, spenderFor(c)],
  })) as bigint;
  if (allowance < need) {
    const h = await approveToken(c, token);
    await c.public.waitForTransactionReceipt({ hash: h });
    sent.push(h);
  }

  if (usesPermit2(c)) {
    const [amt] = (await c.public.readContract({
      address: c.addresses.permit2!,
      abi: PERMIT2,
      functionName: "allowance",
      args: [account, token, c.addresses.router],
    })) as readonly [bigint, number, number];
    if (amt < need) {
      const h = await approvePermit2ForRouter(c, token);
      if (h) {
        await c.public.waitForTransactionReceipt({ hash: h });
        sent.push(h);
      }
    }
  }
  return sent;
}

/** What still stands between this wallet and a working write. */
export interface TokenReadiness {
  usesPermit2: boolean;
  /** ERC-20 allowance to whoever pulls (Permit2 when wired, else the router). */
  needsTokenApproval: boolean;
  /** Permit2's standing allowance for the router. Always false when Permit2 is not wired. */
  needsPermit2Approval: boolean;
}

export async function checkTokenReadiness(
  c: LogswapClient,
  token: Address,
  owner: Address,
  need: bigint,
): Promise<TokenReadiness> {
  const allowance = (await c.public.readContract({
    address: token,
    abi: ERC20,
    functionName: "allowance",
    args: [owner, spenderFor(c)],
  })) as bigint;

  let needsPermit2Approval = false;
  if (usesPermit2(c)) {
    const [amt] = (await c.public.readContract({
      address: c.addresses.permit2!,
      abi: PERMIT2,
      functionName: "allowance",
      args: [owner, token, c.addresses.router],
    })) as readonly [bigint, number, number];
    needsPermit2Approval = amt < need;
  }

  return { usesPermit2: usesPermit2(c), needsTokenApproval: allowance < need, needsPermit2Approval };
}
