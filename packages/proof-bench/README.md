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

## Admission end-to-end gate

The host exports only a verified Groth16 receipt for the compiled admission program. The Solidity gate reads that export and checks acceptance, every journal byte, program identity, proof bytes and verifier selector. It fails if the generated artifact is absent.

```sh
packages/proof-bench/vm/target/release/proof-bench-host --reject-invalid
packages/proof-bench/vm/target/release/proof-bench-host --export packages/proof-bench/results/groth16.bin packages/proof-bench/results/admission.json
(cd packages/proof-bench/evm && FOUNDRY_PROFILE=admission forge test -vv)
```

`--reject-invalid` executes malformed statements inside the guest and requires rejection for an invalid round, insufficient budget, a changed root and a corrupted authenticated payload. It is an execution check, separate from proof verification.

The four-case independent interoperability matrix covers padding, both directions, and a maximum-size order at the final allowed step:

```sh
cargo run --manifest-path packages/proof-bench/Cargo.toml --locked --release -- --matrix > packages/proof-bench/results/matrix.json
node packages/proof-bench/interop.mjs packages/proof-bench/results/matrix.json
```

Keep generated receipts and measurements under the ignored `results/` directory. Measure guest execution, proof generation, wrapping and Solidity verification separately. Preserve toolchain versions and program identity with benchmark results. Only completed end-to-end runs can supply an end-to-end latency sample.

## Optional accelerated curve backend

The `accelerated` feature uses the RISC Zero BLS12-381 fork pinned at `a3192e1bc58921d42d03d99957abf3be55f9d435`. The serialization patch exposes the existing pairing-result coefficients in the standard tlock order; it does not change curve arithmetic. The fork retains its MIT/Apache-2.0 licenses. The adapter implements the same quicknet key-wrapper relation and compares its output byte for byte against the pinned tlock implementation over 64 key/randomness/round cases. AGE payload processing and funding arithmetic are shared by both variants.

```sh
cargo test --manifest-path packages/proof-bench/Cargo.toml --locked --release --features accelerated
cargo build --manifest-path packages/proof-bench/vm/Cargo.toml --locked --release --features accelerated
packages/proof-bench/vm/target/release/proof-bench-host --execute-matrix
packages/proof-bench/vm/target/release/proof-bench-host --reject-invalid
```

The feature changes the guest program identity. Keep each variant's host binary with its receipts and use that binary for wrapping and export. A host compiled for one guest rejects the other guest's receipt. `--execute-matrix` records the program identity, cycles and execution time for padding, both directions, and the maximum-size final-step case. These measurements are guest execution, not completed proof benchmarks.

## Prepared keys and online admission

The `prepared` host retains an AGE encryptor in memory while constructing a preparation witness, then consumes it for one order ciphertext. Its two guest programs check standard tlock key wrapping and online payload/funding admission separately. A domain-separated hiding commitment binds the same context, wrapper and file key in both proofs. Both programs emit canonical ABI-word journals; the online journal starts with the complete 256-byte preparation binding.

Build and generate a synthetic fixture (including private test witnesses under ignored `results/`):

```sh
source env.sh
cargo build --manifest-path packages/proof-bench/vm/Cargo.toml --locked --release --features accelerated --bin prepared
packages/proof-bench/vm/target/release/prepared fixture packages/proof-bench/results/prepared-fixture.json > packages/proof-bench/results/prepared-interop.json
node packages/proof-bench/prepared-interop.mjs packages/proof-bench/results/prepared-interop.json packages/proof-bench/results/prepared-fixture.json
```

The fixture uses historical round 1000 and synthetic order/randomness values. The AGE library generates a fresh file key and nonce for each preparation. Use the same saved fixture for both phases:

```sh
packages/proof-bench/vm/target/release/prepared execute online packages/proof-bench/results/prepared-fixture.json
packages/proof-bench/vm/target/release/prepared reject online packages/proof-bench/results/prepared-fixture.json
packages/proof-bench/vm/target/release/prepared prove online packages/proof-bench/results/prepared-fixture.json packages/proof-bench/results/online-receipt.bin
packages/proof-bench/vm/target/release/prepared wrap online packages/proof-bench/results/online-receipt.bin packages/proof-bench/results/online-groth16.bin
packages/proof-bench/vm/target/release/prepared export online packages/proof-bench/results/online-groth16.bin packages/proof-bench/results/online.json
node packages/proof-bench/prepared-interop.mjs packages/proof-bench/results/prepared-interop.json packages/proof-bench/results/prepared-fixture.json packages/proof-bench/results/online.json online
(cd packages/proof-bench/evm && FOUNDRY_PROFILE=online forge test -vv)
```

Repeat the execution, rejection, proof, wrapping and export commands with `preparation` in place of `online` to generate the matching preparation artifact. Then run `FOUNDRY_PROFILE=prepared forge test -vv` in `evm/` to verify both proofs and their shared binding. The two-proof harness requires both real exports and rejects altered bindings and swapped proofs. Production contracts are separate from these benchmark harnesses.
