# Client

One CLI workflow for a Blindfold trader: check funding, commit an encrypted order, follow it, withdraw.

```bash
npm ci --ignore-scripts
npm test                                   # offline unit tests
npm start -- status                        # wallet / available / reserved / withdrawable, and the open batch's deadlines
npm start -- deposit token1 50
npm start -- commit sell 10 9 --dry-run    # preflight only: funding of every asset, approvals, fee, eligibility, deadlines
npm start -- commit sell 10 9              # deposits any shortfall, encrypts to the batch's drand round, commits
npm start -- track                         # each commitment: committed, revealed, padding, unfunded, slashed, filled, unfilled, expired
npm start -- blockers                      # each commitment blocking withdrawal and the step that clears it
npm start -- cleanup [--dry-run]           # reveal own saved orders, slash unrevealed ones, expire unsettled batches
npm start -- withdraw token0 all           # lists the blockers instead if any remain
npm start -- export-state backup.json      # back up saved orders and salts
npm start -- import-state backup.json      # restore; refused unless every entry hashes right and matches the chain
```

`sell` sells token0 for token1, `buy` sells token1 for token0. Amounts are decimal token units.

Proceeds stay in the vault after a fill, so a repeat trader pays no extra transfers; `withdraw` takes them out. The vault blocks every withdrawal while the account has an open commitment, and `status` says so.

**One active batch per account.** `commit` refuses a new batch while the account has an open commitment in an earlier one, before it encrypts or sends anything. Otherwise the new commit's deposit comes out of the same free balance the older order still needs, and that order can be closed as unfunded (REVIEW R10). Overlapping batches stay off until a rule stops one balance backing two batches.

The client saves each order and salt (`.state/`, or `CLIENT_STATE`) **before** it sends the commit, so a crash never loses what is needed to reveal.

## Configuration
| Var | Default | Meaning |
|---|---|---|
| `RPC_URL` | `http://127.0.0.1:8545` | Chain |
| `DEPLOYMENTS` | `deployments/blindfold.local.json` | Addresses (PLAN.md seam) |
| `CONTRACTS_OUT` | `contracts/out` | ABIs from `forge build` |
| `USER` | `10` | anvil test account index (users are 10–19). Public test keys: local only |
| `PRIVATE_KEY` | — | Use this key instead of an anvil account |
| `DRAND` | quicknet over HTTP | Path to recorded rounds (`test/fixtures/drand.json` format) for offline runs |
| `CLIENT_STATE` | `packages/client/.state` | Where orders and salts are kept |

## Local end-to-end test
Starts its own anvil, deploys the vault and settlement from `contracts/out`, and drives the real CLI.

```bash
source ../../env.sh && (cd ../../contracts && forge build)
CLIENT_E2E=1 npm test
```
