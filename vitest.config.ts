import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The integration suite sends real transactions to a local node. Since writes sign LOCALLY
    // (viem gets the account object, not a bare address), each one costs extra round trips —
    // nonce, gas estimate, chain id — where node-side signing cost none. The default 5s is not
    // enough for a test that sends several in sequence.
    testTimeout: 30_000,
  },
});
