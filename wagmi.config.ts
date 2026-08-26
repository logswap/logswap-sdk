import { defineConfig } from "@wagmi/cli";
import { foundry } from "@wagmi/cli/plugins";

/**
 * Codegen for the SDK. Reads Forge build artifacts from the pinned `contracts/` checkout and emits
 * `src/generated.ts` (gitignored) — the typed ABIs the wrappers consume.
 *
 * ABIs flow contracts → SDK, never the reverse, and nothing downstream ever hand-writes one. That
 * rule is the whole point of the plan in docs/app.md; unimod broke it in two of three places and
 * paid for it. The pinned SHA in `contracts.ref` is the single source of truth for which contract
 * version a build embeds, and `tsc` is the drift gate — a contract change that breaks the SDK is a
 * red build, not a runtime surprise.
 */
export default defineConfig({
  out: "src/generated.ts",
  plugins: [
    foundry({
      project: "contracts",
      // The singleton stack plus BasketPool — the homogeneous-claims sibling deployed beside it.
      // Its zaps live in LogswapRouter (one router, one Permit2 spender), so no fifth entry.
      include: ["LogswapManager.sol/**", "LogswapRouter.sol/**", "LogswapLens.sol/**", "BasketPool.sol/**"],
    }),
  ],
});
