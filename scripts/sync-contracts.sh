#!/usr/bin/env bash
# Fetch the Logswap contracts into a gitignored ./contracts checkout, pinned to the SHA in
# ./contracts.ref. NO git submodule — a plain clone the SDK owns and refreshes.
#
#   Local dev:  npm run contracts:sync
#   CI:         CONTRACTS_REPO=https://x-access-token:$TOKEN@github.com/unimodularxyz/logswap-contract.git \
#                 npm run contracts:sync
#
# The pinned ref is the single source of truth for WHICH contract version this SDK build embeds.
# ABIs flow contracts -> SDK, never the reverse; nothing here is ever hand-copied.
set -euo pipefail

REPO="${CONTRACTS_REPO:-git@github.com:unimodularxyz/logswap-contract.git}"
REF="${CONTRACTS_REF:-$(tr -d ' \n\r' < contracts.ref)}"
DIR="contracts"

if [ ! -d "$DIR/.git" ]; then
    echo "→ cloning $REPO into $DIR"
    git clone "$REPO" "$DIR"
fi

echo "→ checking out contracts @ $REF"
git -C "$DIR" fetch --tags --force origin
git -C "$DIR" checkout --quiet "$REF"

# The contracts' own libs (forge-std, solady, v4-core) are nested submodules — init them so
# `forge build` can compile. Internal to the gitignored checkout; this repo stays submodule-free.
echo "→ syncing contract libs"
git -C "$DIR" submodule update --init --recursive

echo "✓ contracts @ $(git -C "$DIR" rev-parse --short HEAD)"
