#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
revision=717a5d1d91c7182a5e32f291e65583ab8729edbc
if [[ ! -d .deps/tlock-rs ]]; then
  mkdir -p .deps
  git clone https://github.com/thibmeu/tlock-rs.git .deps/tlock-rs
  git -C .deps/tlock-rs checkout --detach "$revision"
  git -C .deps/tlock-rs apply ../../tlock-explicit-randomness.patch
fi
[[ "$(git -C .deps/tlock-rs rev-parse HEAD)" == "$revision" ]]
git -C .deps/tlock-rs apply --reverse --check ../../tlock-explicit-randomness.patch
verifier_revision=365e7b2db4f620fa256580c27558d2623362b9ae
if [[ ! -d .deps/risc0-ethereum ]]; then
  git clone --depth 1 --branch v3.0.1 https://github.com/risc0/risc0-ethereum.git .deps/risc0-ethereum
fi
[[ "$(git -C .deps/risc0-ethereum rev-parse HEAD)" == "$verifier_revision" ]]
git -C .deps/risc0-ethereum diff --exit-code
