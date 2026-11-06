# Solver

Run `npm ci --ignore-scripts`, then `npm test` for the offline search tests. Run `npm start -- --once` to process currently eligible batches once, or `npm start` to poll. Use `npm start -- --json` (or add `--once`) for one JSON status object per cycle, including due batches, settlements and errors. The service reads its settlement address from `deployments/blindfold.local.json` and its ABI from the generated settlement artifact. Existing `RPC_URL`, `DEPLOYMENTS`, `SETTLEMENT_ARTIFACT`, `POLL_MS`, and account environment variables configure those inputs.

When the deployment has a configured external market, the solver reads the
validated reference ending at the batch reveal deadline. With zero active sealed
liquidity it first tries a peer-only crossing at that reference, with price
priority and a common fraction at the equal-limit boundary. Otherwise it searches
the external band in one-basis-point steps, closest to the reference first, and
simulates full fills, then proportional boundary groups, through the public-pool route. It reports the chosen route.
Invalid external reference data aborts the batch attempt, without a stored-price
fallback. Unconfigured deployments use the original sealed AMM search when they
have active liquidity. Older contract ABIs retain their previous peer behavior.

The four-argument settlement call uses a representative order to define a common fraction for every same-side order at its exact limit ratio. The solver applies price priority, computes integer allocations, rounds proportional output minimums up, and searches order-limit discontinuities before bisecting prices. It uses a single block for search reads and simulations, then simulates again against the latest state before sending.

RPC failures propagate. The sealed AMM search has a 4,096-simulation budget; exhausting it raises an explicit error. A search that returns no candidate does not claim that mathematical infeasibility has been established. `--once` exits nonzero if a due batch cannot be submitted successfully. Expiration remains a separate on-chain action.

## Local integration test

This test launches and stops its own anvil, deploys a real PoolManager and the auction contracts, and runs the actual CLI. It covers ordinary proportional sells/buys, peer-only crossings in both directions after liquidity removal, and a one-sided batch that expires and recovers its input. Peer cases assert there are no pool Swap events and no stranded settlement balances. It uses only public anvil test accounts. It also covers one-sided external routing in both directions using a funded mock market with a 10-basis-point execution cost. Contract artifacts must include the external-market configuration, peer-only entry point and proportional overload; the fixture fails explicitly otherwise.

The fixture aligns the start to the drand schedule and charges a nonzero commit fee to a separate treasury. Every scenario checks that fees remain charged after settlement or expiry.

From the repository root:

```bash
source env.sh
export CONTRACTS_DIR="$PWD/contracts"
forge build --root "$CONTRACTS_DIR" --no-dynamic-test-linking
cd packages/solver
npm ci --ignore-scripts
forge build --root "$CONTRACTS_DIR" --no-dynamic-test-linking "$PWD/test/fixtures/SolverHookFactory.sol" \
  --remappings "blindfold/=$CONTRACTS_DIR/src/"
SOLVER_E2E=1 node --test test/integration.test.mjs
```

For integration review before the contract PR is merged, `CONTRACTS_DIR` may point to a separately built checkout containing that implementation. No ABI is copied into this package. The test-only factory supplies its own creation-code hash so CREATE2 address mining uses the exact compiler output deployed by the factory.

## External partial fills and bounded search

After full-fill candidates fail, the external search tries representative orders
for distinct same-side limit groups. Halving seeks an executable fraction;
bisection refines that bracket. Every amount follows the contract's price priority,
equal-limit allocation and rounded-up minimum-output rules. Exact order-limit
edges supplement the one-basis-point price grid. The solver skips zero-fill
candidates, caps external simulations at 4,096 and stops before the batch deadline
with two seconds reserved for submission. A slow successful simulation that
finishes after that deadline is discarded.

The search is a bounded heuristic, not a maximum-volume or infeasibility proof.
Disconnected executable fractions may remain undiscovered. The integration test
covers capacity-limited groups in both directions, including CLI submission,
actual proportional input amounts and user minimum outputs.

## Read-only Ethereum market measurements

Build the contract artifacts, then run:

```bash
CONTRACTS_DIR=/path/to/contracts node packages/solver/benchmark-market.mjs > /tmp/market.json
```

The sampler authenticates the network and resolves the USDC/WETH 500-fee pool from
the canonical factory. It reads 13 blocks spaced 600 blocks apart by default;
`BLOCK_STEP=8` samples recent history on RPCs without archive access. `BLOCKS`
accepts explicit comma-separated block numbers for reproduction, and `ETH_RPC`
selects the endpoint. Any failed sample produces an error entry and nonzero exit.
Results contain observation age, harmonic liquidity, approximate spot/TWAP
deviation and aggregate read latency. They do not measure transaction simulation,
proving, submission or inclusion latency, and do not certify oracle security.


A recorded run is in [benchmarks/ethereum-26353945.json](benchmarks/ethereum-26353945.json).
Its 13 samples cover blocks 26,353,849–26,353,945: observation ages 0–84 seconds,
harmonic liquidity 1.663–1.687 × 10^18, approximate spot/TWAP deviations 4.34–12.52
basis points and aggregate RPC read latency 545–760 ms per sample. This is a
96-block sample, not a volatile-period or day-long calibration.

## Multi-hop market integration

A settlement configured with `UniswapV3Route` uses the same external reference
and settlement calls. No solver-supplied router calldata or per-batch route
selection is added. The route's endpoint tokens remain the auction pair.

The CLI integration test additionally deploys a real two-hop adapter over local
pool fixtures and submits batches in both directions. It covers eleven scenarios
in total. The contract suite separately executes WBTC/WETH/USDC against real
Ethereum pools and verifies intermediate balance cleanup and endpoint payouts.

The allocation model retains the nominal proportional input when it meets the
ceil-rounded minimum. Only a violating allocation falls back to whole reduced
input lots; a zero result stays unfilled. Largest-order representatives preserve
fraction precision when dust orders share a limit. This is a bounded candidate
search, not proof of maximum volume or universal clearing.

## Real-proof admission through the solver CLI

The opt-in admission test uses the client CLI to generate and submit two cumulative
proof-backed orders to `AdmittedSettlement` with actual generated Groth16 verifiers.
It independently decrypts the event ciphertext with the recorded drand fixture,
reveals through another account, checks stale-oracle rejection and retries the
solver CLI through a two-hop route. It checks fills, fees, reveal bounties, funding closure, adapter
balances and client CLI withdrawals. Public pools use local fixtures.

After preparing development parameters with the proof-bench admission setup, run
from the repository root:

```bash
source env.sh
npm ci --prefix packages/client --ignore-scripts
npm ci --prefix packages/solver --ignore-scripts
forge build --root contracts --no-dynamic-test-linking
export ADMISSION_PROVER="$PWD/packages/proof-bench/results/local-prover"
export ADMISSION_PARAMS="$PWD/packages/proof-bench/results/admission-params"
export ADMISSION_MANIFEST_SHA256="$(shasum -a 256 "$ADMISSION_PARAMS/manifest.json" | cut -d ' ' -f 1)"
SOLVER_E2E=1 node --test packages/solver/test/admission.test.mjs
```

`CONTRACTS_OUT` can select generated artifacts from another integrated checkout.
The test owns its Anvil node and uses 900-second development batches and recorded
drand data; it never advances a keeper's chain. Without both `SOLVER_E2E=1` and
`ADMISSION_PARAMS`, ordinary unit-test runs skip this proof-generation test.
