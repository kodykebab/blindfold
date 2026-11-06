# Keeper

Reveals committed orders once their drand round is out, slashes commitments nobody could reveal, settles batches the solver missed, and expires batches nobody settled. Every one of these calls is permissionless; the keeper only makes sure they happen on time.

```bash
(cd ../client && npm ci --ignore-scripts)   # the keeper reuses the client's decrypt and hash helpers
(cd ../solver && npm ci --ignore-scripts)   # and runs the solver for its fallback settlement
npm ci --ignore-scripts
npm test                                    # offline unit tests (needs `forge build` for the settlement ABI)
npm start                                   # poll every POLL_MS
npm start -- --once                         # do what is due now, print one status line, exit non-zero on an unexpected error
```

Work is found from `Committed` events and current contract state only. Nothing depends on Arkiv or any other index.

## Reveal rewards (REVIEW S8)
- The bounty pays for a reveal that **lands on chain**, not for decrypting first. The contract pays `bountyBps` of the deposit to the sender of the first successful `reveal` of a commitment. Any later reveal of it reverts with `BadStatus`.
- The keeper simulates every call right before sending it. When the commitment is already revealed or slashed, or the batch is already finalized, it counts a `lostRace` rather than an error and moves on. Duplicate attempts are expected and harmless.
- A ciphertext that doesn't decrypt, or decrypts to an order that doesn't match its hash or committer, is never sent as a reveal. It is slashed after the reveal window.
- A round that isn't out yet, or a drand outage, leaves the commitment in `waitingBeacon`. The keeper retries every cycle until the reveal window closes.
- Private submission isn't needed for correctness: losing a race costs only the gas of the losing transaction.

## Operation (REVIEW S7)
- **Initial operator (proposal for the team):** the Blindfold team runs one keeper. Locally it uses anvil account 1, a public test key. Live, it uses a team-funded wallet whose key lives in `.env`. Reveal and slash bounties offset part of its gas.
- **Budget:** `KEEPER_BUDGET_WEI` caps total gas spend. With `KEEPER_STATUS` set, the spend survives restarts. The keeper also stops sending below `KEEPER_MIN_BALANCE_WEI`. Skipped work is listed in `skipped`, with the reason.
- **Monitoring:** each cycle prints one JSON line and writes it to `KEEPER_STATUS`. The line has the block, what was due, revealed, slashed and expired counts, `lostRace`, `waitingBeacon`, `unopenable`, `skipped`, `errors`, gas used per action, spend and balance. Alert on non-empty `errors` or `skipped`, or on a status file that stops updating.
- **If the keeper stops:** users recover without it. With the client, `npm start -- cleanup` reveals their own saved orders inside the window, slashes after it, and expires an unsettled batch after its deadline. Then `withdraw` works. Anyone can do the same for anyone's commitments.

Measured on a local anvil (`KEEPER_E2E=1`, gas used per transaction, 3 runs):

| Action | Gas |
|---|---|
| `reveal` (funded order) | 164,901 – 198,275 |
| `reveal` that lost the race inside the same block | 25,353 |
| `slashUnrevealed` | 70,716 – 87,816 |
| `expire` (2 orders) | 77,489 |

## Fallback settlement (FIXES.md fix 3)
If no solver settles a batch within `KEEPER_SETTLE_GRACE_S` seconds of its reveal deadline (default 15), the keeper settles it. It runs `packages/solver/solver.mjs --once` with its own key, so it uses the solver's search, simulation and checks rather than a copy of them. The solver skips batches that are already finalized; a batch someone else settled first counts as `lostRace`. The settlement gas counts against `KEEPER_BUDGET_WEI` like any other send, and `settled` in the status line says how many batches it settled.

The public-pool route only accepts a settlement within the market's `maxDelay` of the reveal deadline. For the fallback to be useful, deploy markets whose `maxDelay` covers the settle window: `ExternalLateSettlementFork.t.sol` settles 240 s late on the real USDC/WETH pool with `maxDelay` 300, and shows a 30 s `maxDelay` rejecting the same settlement.

## Configuration
| Var | Default | Meaning |
|---|---|---|
| `RPC_URL` | `http://127.0.0.1:8545` | Chain |
| `DEPLOYMENTS` | `deployments/blindfold.local.json` | Addresses |
| `KEEPER_INDEX` / `KEEPER_KEY` | `1` / — | anvil account index, or a private key |
| `DRAND` | quicknet over HTTP | Recorded rounds file for offline runs |
| `POLL_MS` | `3000` | Poll interval |
| `KEEPER_BUDGET_WEI` | unlimited | Gas spend cap |
| `KEEPER_MIN_BALANCE_WEI` | `1e15` | Stop sending below this balance |
| `KEEPER_STATUS` | — | Status file for monitoring; carries the spend across restarts |
| `KEEPER_SETTLE_GRACE_S` | `15` | Seconds after the reveal deadline before the keeper settles a batch itself; `off` disables it |
| `KEEPER_SOLVER` | `../solver/solver.mjs` | Solver CLI the fallback runs |

## Local end-to-end test
It starts its own anvil at the time whose batch 0 targets drand round 1,000,000, so the recorded round in `packages/client/test/fixtures` decrypts offline. Two keepers race on the same orders and a garbage commitment gets slashed. A run with the budget at zero and a run below the balance floor send nothing, and the users then recover through the client. A third run has no solver: the keeper leaves the batch alone inside the grace period, then settles it itself.

```bash
source ../../env.sh && (cd ../../contracts && forge build)
KEEPER_E2E=1 npm test
```
