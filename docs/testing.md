# Testing

Three tiers, from fast and offline to slow and complete. Each one starts its own private Anvil chains where needed; none touches a running stack or uses real keys.

```bash
source env.sh
scripts/check.sh                 # offline: contracts, every package, scripts, Go circuit tests   (minutes)
scripts/e2e.sh                   # real web service, CLI, keeper and solver on local chains        (~10 minutes)
scripts/e2e.sh --real-proof      # adds fresh Groth16 proofs end to end                            (longer; needs step 3 of Getting started)
```

| Flag | Effect |
|---|---|
| `check.sh --fork` | Adds contract fork tests against public Ethereum and Unichain RPCs |
| `check.sh --e2e` / `--real-proof` | Runs the e2e tiers after the offline checks |
| `SKIP_RUST=1 check.sh` | Skips the slow proof-bench Rust tests (CI does this) |

## Opt-in suites

Every chain or browser test is opt-in behind an environment variable, so `npm test` stays offline. `e2e.sh` turns on the ones marked ✓.

| Variable | File | Proves | In `e2e.sh` |
|---|---|---|---|
| `WEB_E2E` | `app/haveibeensandwiched/local.e2e.test.mjs` | Backup export and restore through the real page server | ✓ |
| `STACK_E2E` (+ `STACK_REAL_PROOF`) | `packages/solver/test/local-stack.e2e.test.mjs` | A web order through the real keeper and solver to withdrawal; restarts and duplicate work; Arkiv history | ✓ |
| `CLIENT_E2E` | `packages/client/test/e2e.test.mjs` | Client lifecycle: preflight, cleanup, overlapping batches, tamper refusal, vault-only trading, wrong chain, fee-on-transfer | ✓ |
| `KEEPER_E2E` | `packages/keeper/test/e2e.test.mjs` | Racing keepers reveal once; budget limits; users recover with no keeper | ✓ |
| `SOLVER_E2E` | `packages/solver/test/integration.test.mjs` | Sealed, peer, public and multi-hop settlement | ✓ |
| `OUTAGE_E2E` | `scripts/outage.e2e.test.mjs` | RPC down and drand down: clean errors, then recovery | ✓ |
| `DEMO_E2E` | `scripts/demos.e2e.test.mjs` | The Court demo pays the victim; three users through one batch | ✓ |
| `DEV_E2E` | `scripts/dev-stack.test.mjs` | The proof-enforced dev stack starts and every service is healthy | `--real-proof` |
| `ORDERS_E2E` | `app/haveibeensandwiched/orders.e2e.test.mjs` | Browser: beacon delay, keeper outage, expiry | |
| `PROVER_E2E` | `app/haveibeensandwiched/prover.e2e.test.mjs` | Browser: reload mid-commit, tampered backup, backup reminder | |
| `REVIEW_E2E` | `app/haveibeensandwiched/review.e2e.test.mjs` | Browser: fund first, changed balance, stale quote | |
| `A11Y_E2E` (+ `BROWSER`) | `app/haveibeensandwiched/a11y.e2e.test.mjs` | Keyboard reach and visible focus, 375 px width, labelled fields (Chromium by default) | |
| `ADMISSION_E2E` | `app/haveibeensandwiched/admission.e2e.test.mjs` | Browser with real proofs: prepare ahead, commit with only the online proof, next preparation offered (about 10 minutes) | |
| `EXT_E2E` | `packages/extension-e2e` | The Chrome extension with a wallet and the native helper | |

The browser suites need the contracts built and use Playwright's Chromium from `packages/extension-e2e`:

```bash
source env.sh
O=$(mktemp -d); export CONTRACTS_OUT=$O/out FOUNDRY_OUT=$O/out FOUNDRY_CACHE_PATH=$O/cache
forge build --root contracts --force --no-dynamic-test-linking
forge build --root contracts --no-dynamic-test-linking packages/solver/test/fixtures/SolverHookFactory.sol --remappings "blindfold/=$PWD/contracts/src/"
ORDERS_E2E=1 node --test app/haveibeensandwiched/orders.e2e.test.mjs
```

## CI

`.github/workflows/check.yml` runs `check.sh` (without Rust) and then `e2e.sh` on every pull request and every push to `main`. GitHub Actions has to be enabled for the repository.

## Writing tests

- Unit tests are plain `node:test` files named `*.test.mjs`, picked up by `npm test`.
- Chain and browser tests are opt-in (`X_E2E=1`) and start their own chain: use `localChain` from `packages/client/test/chain.mjs`, or `setupStack` from `app/haveibeensandwiched/browser-stack.mjs`.
- Wait for a condition with a deadline, never a fixed sleep. A page refresh is often two chained jobs; see `stageMatches` and `jobDone` in `browser-stack.mjs`.
- Add each new opt-in suite to `scripts/e2e.sh` and to the table above.
