# Solver

Run `npm ci --ignore-scripts`, then `npm test` for the offline search tests. Run `npm start -- --once` to process currently eligible batches once, or `npm start` to poll. The service reads its settlement address from `deployments/blindfold.local.json` and its ABI from the generated settlement artifact. Existing `RPC_URL`, `DEPLOYMENTS`, `SETTLEMENT_ARTIFACT`, `POLL_MS`, and account environment variables configure those inputs.

When the deployment has a configured external market, the solver reads the
validated reference ending at the batch reveal deadline. With zero active sealed
liquidity it first tries a peer-only crossing at that reference, with price
priority and a common fraction at the equal-limit boundary. Otherwise it searches
the external band in one-basis-point steps, closest to the reference first, and
simulates full fills through the public-pool route. It reports the chosen route.
Invalid external reference data aborts the batch attempt, without a stored-price
fallback. Unconfigured deployments use the original sealed AMM search when they
have active liquidity. Older contract ABIs retain their previous peer behavior.

The four-argument settlement call uses a representative order to define a common fraction for every same-side order at its exact limit ratio. The solver applies price priority, computes integer allocations, rounds proportional output minimums up, and searches order-limit discontinuities before bisecting prices. It uses a single block for search reads and simulations, then simulates again against the latest state before sending.

RPC failures propagate. The sealed AMM search has a 4,096-simulation budget; exhausting it raises an explicit error. A search that returns no candidate does not claim that mathematical infeasibility has been established. `--once` exits nonzero if a due batch cannot be submitted successfully. Expiration remains a separate on-chain action.

## Local integration test

This test launches and stops its own anvil, deploys a real PoolManager and the auction contracts, and runs the actual CLI. It covers ordinary proportional sells/buys, peer-only crossings in both directions after liquidity removal, and a one-sided batch that expires and recovers its input. Peer cases assert there are no pool Swap events and no stranded settlement balances. It uses only public anvil test accounts. It also covers one-sided external routing in both directions using a funded mock market with a 10-basis-point execution cost. Contract artifacts must include the external-market configuration, peer-only entry point and proportional overload; the fixture fails explicitly otherwise.

From the repository root:

```bash
source env.sh
export CONTRACTS_DIR="$PWD/contracts"
forge build --root "$CONTRACTS_DIR"
cd packages/solver
npm ci --ignore-scripts
forge build --root "$CONTRACTS_DIR" "$PWD/test/fixtures/SolverHookFactory.sol" \
  --remappings "blindfold/=$CONTRACTS_DIR/src/"
SOLVER_E2E=1 node --test test/integration.test.mjs
```

For integration review before the contract PR is merged, `CONTRACTS_DIR` may point to a separately built checkout containing that implementation. No ABI is copied into this package. The test-only factory supplies its own creation-code hash so CREATE2 address mining uses the exact compiler output deployed by the factory.
