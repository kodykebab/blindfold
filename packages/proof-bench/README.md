# Admission proof feasibility benchmark

The Rust CLI checks a tlock ciphertext and a batch funding transition. It re-creates the file-key wrapper from private randomness, authenticates/decrypts the AGE payload with that key, and checks the canonical order and cumulative funding totals. The VM guest runs the same checker and journals the public statement.

## Native and interoperability checks

From the repository root:

```sh
source env.sh
bash packages/proof-bench/prepare.sh
cargo test --manifest-path packages/proof-bench/Cargo.toml --locked --release
npm ci --prefix packages/proof-bench --ignore-scripts
mkdir -p packages/proof-bench/results
cargo run --manifest-path packages/proof-bench/Cargo.toml --locked --release > packages/proof-bench/results/native.json
node packages/proof-bench/interop.mjs packages/proof-bench/results/native.json
```

The JSON labels native checking timings explicitly. The JS check verifies the historical quicknet signature, decrypts using `tlock-js`, and independently checks Solidity ABI encoding and hashes. Fixtures contain synthetic orders and use an already-published round.

## VM execution and proving

Install the official RISC Zero Rust toolchain, `cargo-risczero` 3.0.6 and `r0vm` 3.0.6 using `rzup`. Set `RISC0_HOME` if installing outside its default location.

```sh
cargo run --manifest-path packages/proof-bench/vm/Cargo.toml --locked --release
cargo run --manifest-path packages/proof-bench/vm/Cargo.toml --locked --release -- --prove packages/proof-bench/results/receipt.bin
cargo run --manifest-path packages/proof-bench/vm/Cargo.toml --locked --release -- --wrap packages/proof-bench/results/receipt.bin packages/proof-bench/results/groth16.bin
```

The first command executes the guest and reports cycles. The second generates and saves a local receipt, verifies its journal against the submitted statement, and checks rejection of a modified journal. The host forces local IPC and disables development-mode receipts. The third compresses the saved receipt into Groth16 using the local Docker wrapper. Mode labels distinguish execution from proof generation and wrapping.

## Solidity verifier check

```sh
(cd packages/proof-bench/evm && forge test -vv)
```

This uses the upstream 3.0 receipt fixture to check the verifier's accepted program/journal and rejection behavior. The fixture test is separate from proof generation for the admission guest.

## Upstream attribution

`prepare.sh` checks out [thibmeu/tlock-rs](https://github.com/thibmeu/tlock-rs) at `717a5d1d91c7182a5e32f291e65583ab8729edbc`, retaining its MIT license. The included patch exposes its existing encryption computation with caller-supplied private randomness. AGE processing uses the upstream `age` library. The Rust key and round-1000 signature fixture originate in upstream tlock's quicknet tests.

The VM build layout uses the RISC Zero 3.0.6 starter structure. See [RISC Zero](https://dev.risczero.com/api/zkvm/quickstart) for tooling installation.

The Solidity verifier and fixture are imported from `risc0/risc0-ethereum` release `v3.0.1` (`365e7b2db4f620fa256580c27558d2623362b9ae`); their original GPL-3.0 and Apache-2.0 notices remain in the checkout.
