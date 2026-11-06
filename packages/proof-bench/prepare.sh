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

bls_revision=a3192e1bc58921d42d03d99957abf3be55f9d435
if [[ ! -d .deps/bls12-381 ]]; then
  git clone --depth 1 --branch bls12_381/v0.8.0-risczero.1 https://github.com/risc0/zkcrypto-bls12_381.git .deps/bls12-381
  git -C .deps/bls12-381 apply ../../bls-serialization.patch
fi
[[ "$(git -C .deps/bls12-381 rev-parse HEAD)" == "$bls_revision" ]]
git -C .deps/bls12-381 apply --reverse --check ../../bls-serialization.patch
