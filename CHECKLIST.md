# Release checklist

Status: `[x]` done · `[~]` partly done · `[ ]` open. Owner: **Claude** (this branch stack), **Cursor** (sections 3 and 8, see `CURSOR_PROMPT.md`), **Antigravity** (section 5 on branch `bhoumik/orders-ui`, see `ANTIGRAVITY_PROMPT.md`), **Team** (needs a decision or another lane).
Updated after every 3 completed tasks. Last update: 2026-11-07, 49 done, 10 partly done, 34 open of 93.

## 1. Local setup and operation (Claude)
- [~] Repeatable clean-clone setup: install, build, deploy. `scripts/dev.sh` works; the clean-clone rehearsal remains.
- [x] Generate and use a local deployment manifest automatically. `dev-stack.mjs` writes `blindfold.local.json`.
- [x] Configure page, CLI, prover, keeper and solver against the same chain and deployment.
- [x] Start and stop the local services predictably. Ctrl-C, or any service exiting, stops the whole stack.
- [x] Show whether the RPC, deployment, prover, keeper and solver are available. Shown in the terminal and in `health.json` (`STACK_HEALTH`); the page panel is still to do.
- [x] Actionable setup errors for every missing or misconfigured dependency. `dev.sh` names each missing tool and how to install it; health gives a next step per service.
- [ ] A new user completes normal trading without terminal commands.

## 2. Wallet, network and account (Claude, in the extension)
- [x] Decide and implement browser-wallet signing alongside the CLI and prover. The extension signs through the wallet via the bridge page (DECISIONS D1–D10); the page keeps the local CLI.
- [x] Wallet connection and disconnection. EIP-6963 connect, bridge disconnect and reconnect (`packages/bridge`, e2e I2).
- [x] Show the CLI account, network and pair after status loads.
- [x] Browser-wallet wrong network and switching. Switch, add the chain on 4902, otherwise `WRONG_CHAIN` before signing (`wallet.test.mjs`).
- [x] Account changes, disconnects and reconnects. `accountsChanged`/`chainChanged` forwarded (e2e I2); `WRONG_ACCOUNT` blocks sending from another account.
- [x] Rejected signatures and transactions. 4001 stops the sequence and reports what was already sent (`wallet.test.mjs`).
- [x] Insufficient funds and gas. The bridge checks ETH for the first call before signing and names `INSUFFICIENT_FUNDS` (`wallet.test.mjs`). The page side is Cursor's.
- [~] Cross-account, cross-network and deployment recovery. The CLI refuses a mismatched chain, vault or pair before signing.
- [ ] Review the webpage/local-service/wallet/prover trust boundary.

## 3. Trading interface (Cursor)
- [x] Configured pair and token symbols in status. `status.test.mjs`: "status JSON is read first and still fills the text-shaped view".
- [x] Wallet, available, reserved and withdrawable balances shown separately. `status.test.mjs`: "balance fields keep wallet, vault, reserved and withdrawable apart".
- [x] Amount precision and numeric limits. `status.test.mjs`: "amount validator rejects extra precision and the uint128 cap without rounding".
- [x] Fresh external quote comparison. `quote.test.mjs`: "X96 prices convert with both decimals, including a price below 1" and "a reverted reference price is null and carries the reason".
- [x] Limit and expiry review. `status.test.mjs`: "preflight review restates the order, fee, deposit, approval and gas".
- [x] Fee, deposit and approval review. `status.test.mjs`: "preflight review restates the order, fee, deposit, approval and gas".
- [x] Explain the one-active-batch rule before submission. `status.test.mjs`: "one active batch is a submission block with a reason".
- [x] Expected partial execution and unused input. `status.test.mjs`: "partial fills report executed and unused input from the fill numbers".
- [x] Stale quotes and changed balances caught before submission. `status.test.mjs`: "a changed balance or a stale quote requires another confirm".
- [x] Liquidity and estimated execution, without promising it. `status.test.mjs`: "dry-run JSON keeps the contract source and does not invent an execution estimate".
- [ ] No raw CLI output anywhere.
- [x] Unsupported tokens and odd transfer behaviour. `e2e.test.mjs`: "a fee-on-transfer token is refused before the vault is credited". `status.test.mjs`: "a short vault credit is treated as a fee-on-transfer or rebasing token".
- [x] No automatic order-specific shortfall deposit. e2e: "vault-only trading refuses shortfalls".

## 4. Prover and admission (Claude)
- [x] Explicit advance preparation for a selected batch.
- [ ] Safe background preparation that doesn't block a current-batch order.
- [~] Real encryption, proving and submission progress. Only an indeterminate indicator and the CLI's stages so far.
- [ ] Failure, deadline and unsupported-device screens.
- [ ] Stale preparation and account/network/batch/parameter changes in the UI.
- [ ] Failed or consumed preparation recovery through the page.
- [ ] Pending-admission resume and duplicate-submission acceptance through the page.
- [ ] Measure preparation, key loading, online proof, memory and inclusion across devices.
- [ ] Choose release cadence and lead time from the measurements. *(Team)*
- [x] CLI-backed local service chosen as the initial helper.
- [ ] Witness/privacy review of the browser-to-helper path.

## 5. Order tracking, cleanup and withdrawal (Antigravity)
- [x] Each order's batch and lifecycle. Proven by packages/client/test/orders.test.mjs ("orderView: revealed order waiting for settlement") and app/haveibeensandwiched/orders.test.mjs ("orderRows returns full row objects from track and blockers JSON fixtures").
- [x] Admission, reveal, full/partial/unfilled/released/expired outcomes in the UI. Proven by app/haveibeensandwiched/orders.test.mjs ("table row: committed" through "table row: expired").
- [x] Filled amounts, received amounts and unused input. Proven by packages/client/test/orders.test.mjs ("orderView: partial fill with unused input") and app/haveibeensandwiched/orders.test.mjs ("table row: filled (partial)").
- [x] Which commitments block withdrawal, with cleanup guidance. Proven by app/haveibeensandwiched/orders.test.mjs ("withdrawalSummary with 0, 1, and 2 blockers").
- [x] Guided reveal, cleanup, expiry and withdrawal. Proven by packages/client/test/orders.test.mjs ("cleanupPayload: formats dry run and completed actions") and app/haveibeensandwiched/orders.test.mjs ("next step buttons and sentences").
- [x] Policy-specific fees, deposits, rewards and refunds. Proven by app/haveibeensandwiched/orders.test.mjs ("policyText with and without admission").
- [x] Browser acceptance for beacon delay, keeper outage and expiry. `ORDERS_E2E=1 node --test app/haveibeensandwiched/orders.e2e.test.mjs`: 3/3 against a real local chain.

## 6. Recovery, finality and private state (Claude)
- [x] Backup export and import through the page.
- [~] Restoration on a separate device. Passed with an isolated second state directory.
- [~] Stale, foreign and tampered backups through the browser. Tampered input is rejected by the CLI.
- [ ] Concurrent-device conflicts.
- [x] Chain confirmation and finality policy. 1 confirmation locally, `CLIENT_CONFIRMATIONS` or 3 elsewhere (`packages/client/tx.mjs`).
- [ ] Reorgs and disappearing or changed receipts and roots.
- [x] Dropped, replaced, reverted and confirmed transactions told apart.
- [x] Nonce, hash and onchain state reconciled before retries. Explicit nonces; a dropped admission is resent, a replaced one keeps pending state.
- [ ] Every interruption and batch-deadline boundary tested.
- [x] Guided recovery for stale state locks. A live owner means wait; an exited owner's lock is cleared with a next step (`packages/client/test/state-lock.test.mjs`).
- [ ] Decide at-rest protection for private state and backups. *(Team decision)*
- [ ] Strong backup prompt, kept until acknowledged.
- [x] A reopened page reconnects to its retained local job.

## 7. Keeper and solver integration (Claude)
- [x] Real keeper and solver run with a local web-client deployment.
- [x] Keeper reveal and solver settlement for a web order on a local v4 pool, admission off. e2e: "web order reaches the real keeper and solver and both traders withdraw".
- [~] The same flow with a fresh proof on the final v4 fixture. Running in `scripts/e2e.sh --real-proof`.
- [ ] Partial-fill, unfilled, expiry and selected-route acceptance together.
- [ ] Duplicate work, restart and outage tests in the integrated stack.
- [ ] RPC, drand and optional-indexer failure tests.
- [ ] User recovery while services are down.
- [ ] Operator funding, monitoring, alerts and incident procedures.
- [ ] Solver feasibility and price-policy review. *(Team)*
- [x] Optional JSON status per solver cycle, checked against the local service.

## 8. Arkiv, Court and demo (Cursor)
- [x] Choose the Arkiv-backed user feature. Public settled batches. `arkiv.test.mjs`: "a settled batch round-trips through the file and drops private fields".
- [x] Arkiv writes and a user-visible read or query. `arkiv.test.mjs`: "a later store reads the same file, newest first". `local-stack.e2e.test.mjs` asserts `GET /api/history` after settle.
- [x] An optional-indexer outage doesn't block recovery. `history.test.mjs`: "history stays unavailable when Arkiv is down, without throwing". `mirror.test.mjs`: "a throwing Arkiv does not fail the settlement".
- [x] Batch, mempool and Court-ledger views. `status.test.mjs`: "batch phase and mempool use only public schedule and counts". `court-view` test: "court ledger skips the registry events it does not show instead of going unavailable".
- [x] Arkiv schema, setup, query and integration docs. `arkiv/schema.md`. Fields locked by `arkiv.test.mjs`: "query rows unwrap Arkiv values and sort oldest first before the recent-batches reverse".
- [~] Court coverage → claim → collection demonstration. `scripts/court-demo.sh` prints each step's transactions. Not a `node --test`.
- [~] Aqua token movement, if still in scope. Out of this demo. See DEMO.md.
- [~] Multi-user demo, written and rehearsed. `scripts/demo-multi.sh` and DEMO.md. Not a `node --test`.
- [~] Decide on optional Swarm support. Out of this release. See DEMO.md.

## 9. Testing and release (Claude)
- [ ] Final web → fresh proof → v4 → keeper → solver → withdrawal test.
- [ ] Partial fills, unfilled orders, cleanup and outages in that acceptance run.
- [ ] Full browser acceptance against real local contracts.
- [ ] Reload, rejected-signature, stale-quote and insufficient-gas/funds browser tests.
- [ ] Keyboard, mobile and supported-browser testing.
- [x] Isolated offline `scripts/check.sh` tier.
- [x] Local `scripts/e2e.sh` tier using actual services.
- [ ] Final fresh-proof and fork tiers on the final commit.
- [ ] CI gates and two independent clean-clone rehearsals.
- [ ] Independent client, contract and prover review. *(Team)*
- [ ] Production proof parameters and authenticated distribution. *(Kritarth)*
- [ ] Verify deployed bytecode, configuration, verifier identities and operators.
- [ ] Reconcile docs and user-facing claims with release behaviour.
- [ ] Release handoff, demo and submission evidence.
