#!/usr/bin/env bash
# Regenerate the derivation vectors FROM THE PINNED CONTRACTS.
#
# `vectors/derivation-vectors.json` is what makes `test/derivation.test.ts` a real
# cross-implementation check rather than a restatement of the TypeScript: the answers come from the
# Solidity, so if the two ever disagree the test fails instead of the SDK silently addressing the
# wrong pool or the wrong position.
#
# Run after bumping contracts.ref. A change here is by definition a TIER-1 event (docs/app.md) —
# `poolId` and the position-id packing are frozen for the life of a deployment — so a diff in this
# file during an ordinary change means something is wrong.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"

npm run --silent contracts:sync
(cd contracts && forge script script/GenVectors.s.sol:GenVectors >/dev/null)
cp contracts/abi/derivation-vectors.json vectors/derivation-vectors.json
echo "✓ vectors regenerated from contracts @ $(git -C contracts rev-parse --short HEAD)"
