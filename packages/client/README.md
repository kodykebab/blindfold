# Client

One CLI workflow for a Blindfold trader: check funding, commit an encrypted order, follow it, withdraw.

```bash
npm ci --ignore-scripts
npm test                                   # offline unit tests
npm start -- status                        # wallet / available / reserved / withdrawable, and the open batch's deadlines
npm start -- deposit token1 50
npm start -- commit sell 10 --dry-run      # preflight only: quote, limit, funding of every asset, approvals, fee, eligibility, deadlines
npm start -- commit sell 10                # limit = fresh market quote less 50 bps; deposits any shortfall, encrypts, commits
npm start -- commit sell 10 --slippage 30  # a tighter limit
npm start -- commit sell 10 9              # an explicit minimum output instead of a quote
npm start -- resubmit                      # place the last unfilled or expired order again, re-quoted
npm start -- track                         # each commitment: committed, revealed, padding, unfunded, slashed, filled, unfilled, expired
npm start -- blockers                      # each commitment blocking withdrawal and the step that clears it
npm start -- cleanup [--dry-run]           # reveal own saved orders, slash unrevealed ones, expire unsettled batches
npm start -- withdraw token0 all           # lists the blockers instead if any remain
npm start -- export-state backup.json      # back up saved orders and salts
npm start -- import-state backup.json      # restore; refused unless every entry hashes right and matches the chain
npm start -- restore-backup                # decrypt the automatic backup with this wallet and import it
```

`sell` sells token0 for token1, `buy` sells token1 for token0. Amounts are decimal token units.

## Automatic encrypted backup (FIXES.md fix 6)
Orders, salts and funding openings exist only on this device. Without them you can't reveal your own order (a keeper must, or the commitment is released or slashed), and you can't append to your funding root. After every command that changes them, the client writes an encrypted backup to `CLIENT_BACKUP_DIR` (default `~/.blindfold/backups`). Point it at a synced or external folder so it survives the device. `npm start -- backup` writes one immediately.

- **Key.** By default it comes from your wallet: the client signs a fixed, labelled message ("Blindfold backup key v1 …"). Local accounts sign deterministically, so the same wallet on a new device recreates it, and there's nothing else to remember. Sign that message only in this client. `CLIENT_BACKUP_PASSPHRASE` uses a passphrase (scrypt) instead.
- **Format.** AES-256-GCM. The chain, settlement, owner and salt are bound as authenticated data, so an edited file or header fails to decrypt. The file is written atomically with owner-only permissions.
- **Restore.** `restore-backup [file]` decrypts the backup and runs the same checks as `import-state`: every order must hash to its commitment, and every id must match the chain.
- **What it leaves out:** ready preparation keys and proving times, like exports.
- `CLIENT_BACKUP=off` disables it.

## Limits from a fresh quote (FIXES.md fix 4)
Without a minimum output, `commit` quotes the order from the deployment's external market and sets the limit `--slippage` basis points below the quote (default 50). The quote is the market's validated reference price ending at the latest block, after the pool fee (combined over a route's hops). It is the same price check a batch settles against, so a market that can't price the pair now refuses the order before anything is sent, instead of letting it expire. The order is shown as "at least X, or you keep your funds". The limit is the only promise: the batch clears at one price, and you may get more than X but never less.

In the order-flow replay (`packages/solver/replay.mjs`), a 50 bps limit filled 90–95% of USDC/WETH orders; a 10 bps limit filled about half, because the price moves while an order waits. A deployment without an external market needs an explicit minimum. `QUOTE_MAX_AGE_S` (default 120) refuses to quote when the RPC's latest block is older than that by the local clock (`off` disables it; local test chains run at past timestamps).

## Trying again (FIXES.md fix 5)
`resubmit` finds the most recent unfilled or expired order this client still has and places it again, in the next batch it can make: with a fresh quote when the deployment has a market (`--slippage` applies), at the same limit otherwise (or with `--slippage keep`). Each original is resubmitted once; `track` and the saved state record which commitment replaced it. A new commitment pays the commit fee again. The fee prices batch capacity (REVIEW R3/S3), and refunding it for unfilled orders would need its own economic case first.

`keep-ready` keeps one preparation ready for the earliest batch this device can still make, so the next order, or a resubmit, needs only the online proof. It prepares again whenever the key is used or its batch passes, which costs about one preparation of CPU (about 55 s on the measured M5) each time. Run it only while you trade; `keep-ready --once` makes one check and exits. It takes the state lock only while it prepares, so the same account can commit while it runs.

Proceeds stay in the vault after a fill, so a repeat trader pays no extra transfers; `withdraw` takes them out. The vault blocks every withdrawal while the account has an open commitment, and `status` says so.

**One active batch per account.** `commit` refuses a new batch while the account has an open commitment in an earlier one, before it encrypts or sends anything. Otherwise the new commit's deposit comes out of the same free balance the older order still needs, and that order can be closed as unfunded (REVIEW R10). Overlapping batches stay off until a rule stops one balance backing two batches.

The client saves each order and salt (`.state/`, or `CLIENT_STATE`) **before** it sends the commit, so a crash never loses what is needed to reveal.

## Configuration
| Var | Default | Meaning |
|---|---|---|
| `RPC_URL` | `http://127.0.0.1:8545` | Chain |
| `DEPLOYMENTS` | `deployments/blindfold.local.json` | Addresses (PLAN.md seam) |
| `CONTRACTS_OUT` | `contracts/out` | ABIs from `forge build` |
| `CLIENT_ACCOUNT_INDEX` | `10` | Anvil account index (users are 10–19). Numeric `USER` remains a legacy fallback; OS usernames are ignored. Public test keys: local only |
| `PRIVATE_KEY` | — | Use this key instead of an anvil account |
| `DRAND` | quicknet over HTTP | Path to recorded rounds (`test/fixtures/drand.json` format) for offline runs |
| `CLIENT_STATE` | `packages/client/.state` | Where orders and salts are kept |
| `CLIENT_BACKUP_DIR` | `~/.blindfold/backups` | Where the encrypted backup goes; `CLIENT_BACKUP=off` disables it |
| `CLIENT_BACKUP_PASSPHRASE` | — | Encrypt backups with this passphrase instead of a wallet-derived key |
| `QUOTE_MAX_AGE_S` | `120` | Refuse a quote when the latest block is older than this; `off` disables |
| `KEEP_READY_POLL_MS` | `10000` | How often `keep-ready` checks its key |

## Local end-to-end test
Starts its own anvil, deploys the vault and settlement from `contracts/out`, and drives the real CLI.

```bash
source ../../env.sh && (cd ../../contracts && forge build --no-dynamic-test-linking)
CLIENT_E2E=1 npm test
```


For a deployment exposing `admissionRequired()`, cleanup uses the onchain policy: an unrevealed admitted commitment releases its deposit and retains the fee; an unchecked commitment is slashed. Both use `slashUnrevealed`. `track` shows `released` as terminal, so it no longer blocks a later batch or offers repeat cleanup.

The fee/timing integration also supplies `ReleasePolicySettlement` in the generated `FeesAndTiming.t.sol` artifacts. To exercise that policy through the CLI:

```bash
CONTRACTS_OUT=/absolute/path/to/integrated/contracts/out CLIENT_E2E=1 CLIENT_RELEASE_E2E=1 npm test
```

This fixture selects the release policy only; it does not verify admission proofs. The test checks a nonzero fee, deposit return, repeated cleanup without sending another transaction, refusal to use the policy-only fixture as a proof-enabled deployment, and withdrawal. Ordinary CLI tests use an aligned, nonoverlapping schedule and work with the original constructor as well as the fee-aware constructor.


## Local proof-enforced admission

For `AdmittedSettlement`, `commit` generates direct Groth16 proofs locally and calls `admit`. Its deployment file supplies an `admission` object with `manifestSha256`, `preparationVerifier` and `onlineVerifier`; the manifest is the SHA-256 pin for the generated parameter files. The local parameter tool accepts chain 31337. Read the ABI from the `AdmittedSettlement` build artifact.

The client includes all prior private inputs in its funding preflight. It persists totals, blinding and the pending transition before submission, confirms the chain root before appending, and includes that state in exports. Use `npm start -- resume-admission` after an interrupted submission. Restore a current export when this device lacks the opening for an active onchain root. Once all commitments close, the next opening is canonical zero. Mutation commands serialize with a per-account lock; if a process is forcibly terminated, inspect the PID in the reported lock file and remove that file only after the process has exited.

`ADMISSION_PROVER` defaults to `packages/proof-bench/results/local-prover`; `ADMISSION_PARAMS` defaults to `packages/proof-bench/results/admission-params`. Both paths are relative to the repository root by default. Witnesses remain local, in private temporary files removed after proving. State and exports use owner-only permissions.

From the repository root, after installing the existing client dependencies, run:

```bash
source env.sh
bash packages/proof-bench/check-admission.sh
```

This creates reusable development parameters when absent, builds generated verifiers and deployable contract artifacts, then starts an isolated Anvil chain. The fixture uses 300-second development batches and recorded quicknet data. It generates fresh proofs, checks rejection and resume paths, restores private state, decrypts independently, reveals, settles and withdraws, and separately exercises unrevealed release. Setup parameters stay under ignored `results/`.

## Prepare before choosing an order

```bash
npm start -- prepare-admission             # the earliest batch this device can still make (or name one: prepare-admission 42)
npm start -- commit sell 10 9 --dry-run    # shows which batch the order goes into
npm start -- commit sell 10 9
```

`prepare-admission` creates and proves a fresh quicknet key wrapper without an order or funding witness. Without a batch number it picks the current batch if this device can still prepare and prove an order in it, otherwise the next one. It keeps one ready preparation in the existing private state file; another successful preparation replaces it. Account, chain, settlement, batch, round and parameter manifest must match at submission. The RPC chain ID is checked as well. A preparation for a batch that has closed is discarded at the next commit.

**Which batch an order goes into.** `commit` uses the current batch when enough time remains to prove there: with the ready preparation if it is for this batch, else inline. Otherwise it proves for the next batch (using a preparation made for it, if there is one), saves the pending submission, waits until that batch opens and submits. The order never waits more than one batch, and `--dry-run` says which batch it chose. If the process stops while waiting, `resume-admission` submits the saved proof while its batch is open.

`commit` durably consumes the preparation before encrypting the selected order, then generates only the online proof. A failed or interrupted attempt consumes that key; run `prepare-admission` again for a fresh one. Completed pending submissions still use `resume-admission`, which resends or reconciles the same saved ciphertext. With no ready preparation, the existing inline two-proof flow remains available. Neither path submits unchecked ciphertext to the enforced settlement.

Exports contain orders and funding openings but omit unused preparation keys. Restoring an export never restores a ready preparation. Run `prepare-admission` on the restored device. Private temporary witnesses are removed when the prover exits; forcibly terminating the client can leave its private temporary directory and state lock for manual cleanup.

For native local-helper measurements, build the prover and run from the repository root:

```bash
source env.sh
(cd packages/proof-bench/circuit && go build -o ../results/local-prover .)
node packages/proof-bench/measure-admission.mjs 3
```

The result under `packages/proof-bench/results/advance-preparation-measurements.json` records device/tool identities, parameter hashes, separate loading/proving/verification times and peak prover RSS. Every proof uses a fresh process; filesystem cache is uncontrolled. Use a user-controlled machine with the Go toolchain and the local parameter files. Prover errors stop submission; retry on a machine that completes the local gate if the current device cannot run the helper.

**Proving margin.** The client records how long this device takes for each preparation, online proof and inline proof (the last five of each, in the private state file; exports leave them out because another device measures its own). Once it has three samples for a mode, the time that must remain before commits close is 1.25 × the slowest recent sample plus `ADMISSION_INCLUSION_SECONDS` (default 15) for the transaction, and never under 30 s. On the measured M5 (47 s online proofs) that is 74 s instead of 120 s. Until then it uses the development defaults: 120 s with a ready preparation, 180 s inline. A slow attempt raises the margin straight away, because it is recorded before the deadline check, including when the deadline was missed. `ADMISSION_MIN_LEAD_SECONDS` still overrides everything with a fixed positive integer. Recheck the deadline after proving; a missed deadline sends nothing. Production timing remains tracked in REVIEW R6/R7.

On macOS, prefix a measurement or long proof test with `caffeinate -i` to prevent idle sleep for that process, and keep the lid open. The assertion ends with the process.
