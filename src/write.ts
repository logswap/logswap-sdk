/**
 * write.ts — shared plumbing for every mutating call.
 *
 * Two conventions every write helper inherits, so no caller has to remember them:
 *
 * **Deadlines are mandatory on-chain and defaulted here.** Every mutating router entry carries
 * `checkDeadline`. Passing `type(uint256).max` disables it, which is what most SDKs do implicitly
 * and is a real hazard for a user whose transaction sits in the mempool through a price move. The
 * default is a bounded window; pass `deadline: NEVER` only deliberately.
 *
 * **Slippage is expressed as a bound, never as a percentage of a stale quote.** Helpers take the
 * raw `minOut`/`maxIn` the contract wants. `withSlippage()` derives one from a quote when that is
 * what you have — but the bound is what ships.
 */

import type { Address, Hash } from "viem";
import type { LogswapClient } from "./client.js";

/** Disables the deadline check. Deliberate opt-out, never a default. */
export const NEVER = (1n << 256n) - 1n;

/** Default deadline window: 20 minutes, the same order as every major DEX front end. */
export const DEFAULT_DEADLINE_SECONDS = 20n * 60n;

export interface WriteOptions {
  /** Absolute unix seconds. Defaults to now + {@link DEFAULT_DEADLINE_SECONDS}. */
  deadline?: bigint;
  /** Who receives the output. Defaults to the wallet account. */
  recipient?: Address;
}

export function resolveDeadline(o: WriteOptions | undefined, now = Date.now()): bigint {
  return o?.deadline ?? BigInt(Math.floor(now / 1000)) + DEFAULT_DEADLINE_SECONDS;
}

/**
 * The wallet's account, as the ACCOUNT OBJECT rather than its address.
 *
 * This distinction decides how the transaction is signed, and getting it wrong fails in only half
 * the cases — which is how it survived a long time here. viem treats a bare `0x…` address as a
 * *JSON-RPC account* and calls `eth_sendTransaction`, asking the NODE to sign. That is right for an
 * injected wallet and wrong for a local account, which must sign in-process and send
 * `eth_sendRawTransaction`.
 *
 * A dev node holds the keys for its own accounts, so passing an address appears to work right up
 * until someone uses a key the node does not have — a bot, a script, CI, or a real user's wallet.
 * Passing the object lets viem pick the correct path for both kinds.
 */
export function requireWallet(c: LogswapClient): { account: NonNullable<LogswapClient["wallet"]>["account"]; address: Address } {
  const account = c.wallet?.account;
  if (!c.wallet || !account) {
    throw new Error("logswap: this call needs a wallet client — createLogswapClient({ wallet, … })");
  }
  return { account, address: account.address };
}

export function resolveRecipient(c: LogswapClient, o?: WriteOptions): Address {
  return o?.recipient ?? requireWallet(c).address;
}

/**
 * Turn a quoted amount into a slippage bound.
 *
 * `bps` is basis points of tolerance. Direction matters: an output bound floors, an input bound
 * ceilings. Getting that backwards produces a bound that can never bind, which is worse than no
 * bound at all because it looks protective.
 */
export function withSlippage(quoted: bigint, bps: number, side: "output" | "input"): bigint {
  if (bps < 0 || bps > 10_000) throw new Error(`logswap: slippage bps out of range: ${bps}`);
  const b = BigInt(Math.round(bps));
  return side === "output" ? (quoted * (10_000n - b)) / 10_000n : (quoted * (10_000n + b)) / 10_000n;
}

/**
 * Send a router write with a gas buffer over an explicit estimate.
 *
 * A swap's gas is path-dependent: how many ticks it crosses depends on the price when it LANDS, not
 * when it was estimated, and the variance kernel does more work when a block boundary has passed
 * since the last touch. An exact `eth_estimateGas` can therefore OutOfGas one block later. Every
 * write goes through here.
 */
export async function sendRouterWrite(
  c: LogswapClient,
  args: { abi: readonly unknown[]; functionName: string; args: readonly unknown[]; bufferPct?: bigint },
): Promise<Hash> {
  const { account } = requireWallet(c);
  const params = {
    address: c.addresses.router,
    abi: args.abi,
    functionName: args.functionName,
    args: args.args,
    account,
    chain: c.wallet!.chain,
  } as never;

  const estimate = await c.public.estimateContractGas(params);
  const gas = (estimate * (100n + (args.bufferPct ?? 30n))) / 100n;
  return c.wallet!.writeContract({ ...(params as object), gas } as never);
}

/** Simulate a router write and return its decoded result, without sending. */
export async function simulateRouterWrite<T>(
  c: LogswapClient,
  args: { abi: readonly unknown[]; functionName: string; args: readonly unknown[]; account?: Address },
): Promise<T> {
  const account = args.account ?? c.wallet?.account?.address;
  const { result } = await c.public.simulateContract({
    address: c.addresses.router,
    abi: args.abi,
    functionName: args.functionName,
    args: args.args,
    account,
  } as never);
  return result as T;
}
