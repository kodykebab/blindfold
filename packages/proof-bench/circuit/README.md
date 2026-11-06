# Direct local funding circuit benchmark

This Go module proves the existing Rust order hash and private funding-root transition using a BN254 Groth16 circuit. It reads the same synthetic prepared fixture as the two-proof benchmark. Public inputs include deployment, owner, batch, step, roots, order hash and both uint256 budgets. Order fields, cumulative totals and commitment blindings are private witnesses.

The circuit uses the original Keccak and Solidity ABI encodings, 128-bit order amounts, the 64-order aggregate bound, canonical zero initialization and bytewise uint256 budget comparisons. It generates and verifies a proof locally without a zkVM or a separate compression stage. The program generates a fresh ephemeral Groth16 setup for each benchmark invocation; these parameters are for benchmarking only.

Generate `../results/prepared-fixture.json` using the prepared Rust host first, as described in the parent README. Then, from this directory:

```sh
go test -count=1 -v .
go build -o ../results/funding-circuit .
../results/funding-circuit ../results/prepared-fixture.json
```

The final JSON reports constraints and separate compilation, setup, proving and native verification durations. `mode=local_funding_component_groth16` identifies this component measurement. Encryption correctness belongs to the separate encryption relation; this executable is a funding benchmark, not an admission verifier. Tests cover the Rust fixture, continuation, both directions, final-step padding, maximum totals, full-width budgets and malformed statements.

Dependencies are pinned in `go.mod` and `go.sum`. The benchmark uses Consensys gnark under Apache-2.0 and gnark-crypto under Apache-2.0; their package sources retain upstream notices.
