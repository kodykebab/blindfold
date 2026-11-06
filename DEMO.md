# Demo

Two local runbooks. Neither needs a funded mainnet key. Anvil's public test accounts only.

## Court: coverage, claim, collection

`scripts/court-demo.sh` starts its own anvil on port 8555 (override with `PORT`) and the leaky RPC on 8546. It does not use an auction deployment. Stop anything already bound to that port first.

```bash
source env.sh
scripts/court-demo.sh
```

Each step prints the transactions mined during that step. The script deploys a plain pool and the sandwich bot, deploys Court with that pool listed and the RPC signer bonded, leaks one victim swap, sandwiches it in one block, then has the watcher claim and, after `CLAIM_WINDOW` seconds (default 5), collect. It passes only if the beneficiary's balance increases by the payout.

`CLAIM_WINDOW=5` is the usual local run. A longer window is the same script.

### Aqua token movement

Out of scope for this demo. The Aqua leg inside `settle` is still unbuilt (HANDOFF status table; PLAN's Aqua strategy and Aqua-in-settle items are open, and PLAN lists the in-settle Aqua leg as something that can be cut after the standalone Aqua fill). `scripts/court-demo.sh` does not move auction tokens through Aqua. Issue #26 is the integrations item for that token-moving flow; it is not part of the Court claim path, and this runbook does not add a step for it.

## Three users, one batch

`scripts/demo-multi.sh` starts its own anvil on port 8547, deploys the vault, a v4 pool with no liquidity, settlement and a mock external reference, then:

1. Accounts 10, 11 and 12 deposit both test tokens and commit into batch 0 (`--vault-only --both-funded`, so the CLI will not top up a shortfall).
2. The clock moves to that batch's reveal open. The keeper (account 1) reveals. Encryption uses the recorded drand round 1000000, not a live beacon. Do not point this script at a chain a live keeper is using.
3. The clock moves to the settle open. The solver (account 2) settles.
4. Each of the three accounts withdraws both tokens.

The chain starts at a timestamp aligned to drand round 1000000. Batch length is 300s so the three commits land in one batch. Reveal length is 24s and the settle window is 30s. Wall-clock time is the deploys and the CLI. The script sets the next block timestamp for reveal and settle, and it sets anvil's block interval to 0 so mining does not walk out of the commit window.

```bash
source env.sh
forge build --root contracts
scripts/demo-multi.sh
```

### Timings from a rehearsal

Recorded below after a local run. If that run failed, the failure line is the record, not a claim that settlement happened.

See the command log at the bottom of this file after the rehearsal note is filled in.

## Swarm

Swarm support is out. PLAN lists it as a Could, and it is the first item to cut. HANDOFF still needs a Swarm postage batch from a person, and ciphertext storage is not required for the public batch history or for commit, reveal, settle or withdraw. `ctRef` stays an unused commitment attribute. Nothing in this repo uploads to Swarm.

## Rehearsal

`source env.sh && node scripts/demo-multi.mjs` on 7 Nov 2026 finished in about 5 seconds of wall clock and exited 0.

Chain schedule: batch 300s, reveal 24s, settle 30s, clock moved with `evm_setNextBlockTimestamp`. Recorded drand round 1000000.

| Step | Transaction |
|---|---|
| Account 10 commit, batch 0 | `0x7d300427b5bc3f145cd4f027851f925053b2fefea7ce3357981333f5f4c87a2d` |
| Account 11 commit, batch 0 | `0x9c0ab53a2ff387a8b3ce7d88abe997b652e0ab140983b29810e2fd0c4dc64464` |
| Account 12 commit, batch 0 | `0xbcee8ee3b35d37f129966a1fe31bd2d06ae1dcd79f87eaac97249239fbefa085` |
| Keeper reveals (3) | `0x3bd749357fcece15980fa9359be4722d7179f391b51f59199063edef13d250a1`, `0x74b6e2554395e1f3083a64e9b44fcd30e309ac8a2c05ba2a4d8ce3f61b24bd8d`, `0xd42a18331cbdd30dfd3a0552c193796a46a25ded98c54285934554445a4d785b` |
| Solver settle, 3 orders, peer route | `0xffe4e7b9d71d9f03bcd9453504178db3403a39d3582734e5d49e127ae3313524` |

Withdrawals then succeeded for accounts 10, 11 and 12, both tokens. The first attempt failed because anvil's default one-second block interval pushed account 12 into batch 1; the script now sets the interval to 0 and uses a 300s batch. Settlement was peer-only against the mock external reference because the pool was initialized with no liquidity. That is what this deployment's solver does in that case. It is not an Aqua transfer.
