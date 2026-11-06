# Release checklist

Status: `[x]` done · `[~]` partly done · `[ ]` open. Owner: **Claude** (this branch stack), **Cursor** (sections 3 and 8, see `CURSOR_PROMPT.md`), **Antigravity** (section 5 on branch `bhoumik/orders-ui`, see `ANTIGRAVITY_PROMPT.md`), **Team** (needs a decision or another lane).
Updated after every 3 completed tasks. Last update: 2026-11-07, 68 done, 9 partly done, 16 open of 93.

## 1. Local setup and operation (Claude)
- [x] Repeatable clean-clone setup: install, build, deploy. A fresh clone of #82 passed `check.sh` (after committing the prover-helper lockfile it caught) and every `e2e.sh` tier.
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
- [x] Cross-account, cross-network and deployment recovery. CLI refuses a mismatched chain, vault or pair before signing (`CLIENT_E2E`); state is keyed by chain, settlement and owner; foreign backups are refused (`PROVER_E2E`, `prover-view.test.mjs`); a changed identity disables submit on the page.
- [x] Review the webpage/local-service/wallet/prover trust boundary. `TRUST-BOUNDARIES.md`; it fixed page framing (`server.test.mjs`) and lists the open items.

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
- [x] No raw CLI output anywhere. Client, server, network and wallet errors all go through `explainClientError` (`status.test.mjs`: "server and network errors never reach the page raw"); browser suites assert no `client:` text.
- [x] Unsupported tokens and odd transfer behaviour. `e2e.test.mjs`: "a fee-on-transfer token is refused before the vault is credited". `status.test.mjs`: "a short vault credit is treated as a fee-on-transfer or rebasing token".
- [x] No automatic order-specific shortfall deposit. e2e: "vault-only trading refuses shortfalls".

## 4. Prover and admission (Claude, round 2 of Antigravity's prompt)
- [x] Explicit advance preparation for a selected batch.
- [ ] Safe background preparation that doesn't block a current-batch order.
- [x] Real encryption, proving and submission progress. Encrypt → Prove → Submit → Included from the client's own lines, with elapsed and usual time (`prover-view.test.mjs`; `PROVER_E2E`: reload mid-commit).
- [x] Failure, deadline and unsupported-device screens. `status.test.mjs`: "prover, deadline and busy failures each get a sentence and a next step" (out of memory, missing prover, NotCurrentBatch).
- [x] Stale preparation and account/network/batch/parameter changes in the UI. `prover-view.test.mjs`: "preparation panel: every status line the client prints", "identity change between status reads".
- [~] Failed or consumed preparation recovery through the page. Prepare-for-next-batch action and messages are unit-tested; no admission-on browser test yet.
- [~] Pending-admission resume and duplicate-submission acceptance through the page. Resume admission button and "already running" are unit-tested; no admission-on browser test yet.
- [ ] Measure preparation, key loading, online proof, memory and inclusion across devices.
- [ ] Choose release cadence and lead time from the measurements. *(Team)*
- [x] CLI-backed local service chosen as the initial helper.
- [x] Witness/privacy review of the browser-to-helper path. `TRUST-BOUNDARIES.md`; witness files a killed prover left are now swept (`sweep.test.mjs`).

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
- [x] Stale, foreign and tampered backups through the browser. `PROVER_E2E`: "a tampered backup is refused with a clear reason and local state is unchanged"; each kind in `prover-view.test.mjs`.
- [ ] Concurrent-device conflicts. *(second Claude account, branch `bhoumik/release-ops-2`)*
- [x] Chain confirmation and finality policy. 1 confirmation locally, `CLIENT_CONFIRMATIONS` or 3 elsewhere (`packages/client/tx.mjs`).
- [~] Reorgs and disappearing or changed receipts and roots. Receipts are re-read after their confirmations and reported only if still in the same block (`tx.test.mjs`); admission roots reconcile with the chain on resume. No reorg test on a live fork.
- [x] Dropped, replaced, reverted and confirmed transactions told apart.
- [x] Nonce, hash and onchain state reconciled before retries. Explicit nonces; a dropped admission is resent, a replaced one keeps pending state.
- [ ] Every interruption and batch-deadline boundary tested. *(second Claude account, branch `bhoumik/release-ops-2`)*
- [x] Guided recovery for stale state locks. A live owner means wait; an exited owner's lock is cleared with a next step (`packages/client/test/state-lock.test.mjs`).
- [ ] Decide at-rest protection for private state and backups. *(Team decision)*
- [x] Strong backup prompt, kept until acknowledged. Clears only after an export made since the last order is confirmed (`prover-view.test.mjs`; `PROVER_E2E`: "the backup reminder survives reloads").
- [x] A reopened page reconnects to its retained local job.

## 7. Keeper and solver integration (Claude)
- [x] Real keeper and solver run with a local web-client deployment.
- [x] Keeper reveal and solver settlement for a web order on a local v4 pool, admission off. e2e: "web order reaches the real keeper and solver and both traders withdraw".
- [x] The same flow with a fresh proof on the final v4 fixture. `scripts/e2e.sh --real-proof`: all tiers passed (fresh-proof stack and admission recovery).
- [ ] Partial-fill, unfilled, expiry and selected-route acceptance together. *(second Claude account, branch `bhoumik/release-ops-2`)*
- [x] Duplicate work, restart and outage tests in the integrated stack. `STACK_E2E` restart checks, keeper e2e S8 (racing keepers), `OUTAGE_E2E`.
- [x] RPC, drand and optional-indexer failure tests. `scripts/outage.e2e.test.mjs` (RPC and drand down, then back); Arkiv down in `history.test.mjs`.
- [x] User recovery while services are down. Keeper e2e S7 and `ORDERS_E2E` keeper-outage and expiry scenarios.
- [ ] Operator funding, monitoring, alerts and incident procedures. *(second Claude account, branch `bhoumik/release-ops-2`)*
- [ ] Solver feasibility and price-policy review. *(Team)*
- [x] Optional JSON status per solver cycle, checked against the local service.

## 8. Arkiv, Court and demo (Cursor)
- [x] Choose the Arkiv-backed user feature. Public settled batches. `arkiv.test.mjs`: "a settled batch round-trips through the file and drops private fields".
- [x] Arkiv writes and a user-visible read or query. `arkiv.test.mjs`: "a later store reads the same file, newest first". `local-stack.e2e.test.mjs` asserts `GET /api/history` after settle.
- [x] An optional-indexer outage doesn't block recovery. `history.test.mjs`: "history stays unavailable when Arkiv is down, without throwing". `mirror.test.mjs`: "a throwing Arkiv does not fail the settlement".
- [x] Batch, mempool and Court-ledger views. `status.test.mjs`: "batch phase and mempool use only public schedule and counts". `court-view` test: "court ledger skips the registry events it does not show instead of going unavailable".
- [x] Arkiv schema, setup, query and integration docs. `arkiv/schema.md`. Fields locked by `arkiv.test.mjs`: "query rows unwrap Arkiv values and sort oldest first before the recent-batches reverse".
- [x] Court coverage → claim → collection demonstration. `DEMO_E2E`: "Court demo: a sandwiched victim claims from the RPC bond and is paid" (it also fixed the script's broken transaction printer).
- [~] Aqua token movement, if still in scope. Out of this demo. See DEMO.md.
- [x] Multi-user demo, written and rehearsed. `DEMO_E2E`: "multi-user demo: three accounts commit, the keeper reveals, the solver settles, all withdraw"; rehearsal record in DEMO.md.
- [~] Decide on optional Swarm support. Out of this release. See DEMO.md.

## 9. Testing and release (Claude)
- [x] Final web → fresh proof → v4 → keeper → solver → withdrawal test. `STACK_E2E=1 STACK_REAL_PROOF=1` passed in `e2e.sh --real-proof`.
- [ ] Partial fills, unfilled orders, cleanup and outages in that acceptance run.
- [x] Full browser acceptance against real local contracts. `ORDERS_E2E` 3/3, `PROVER_E2E` 3/3, `WEB_E2E`.
- [x] Reload, rejected-signature, stale-quote and insufficient-gas/funds browser tests. Reload in `PROVER_E2E`; fund-first, changed balance and stale quote in `REVIEW_E2E`. The page never signs (the CLI does), so rejected signatures and wallet gas are tested in the extension's bridge (`wallet.test.mjs`).
- [~] Keyboard, mobile and supported-browser testing. `A11Y_E2E`: Tab reaches every control with visible focus; nothing scrolls at 375 px; every field labelled. Chromium only.
- [x] Isolated offline `scripts/check.sh` tier.
- [x] Local `scripts/e2e.sh` tier using actual services.
- [ ] Final fresh-proof and fork tiers on the final commit.
- [~] CI gates and two independent clean-clone rehearsals. Workflow written; GitHub Actions has never run in the repo (needs Kritarth). One local rehearsal passed.
- [ ] Independent client, contract and prover review. *(Team)*
- [ ] Production proof parameters and authenticated distribution. *(Kritarth)*
- [ ] Verify deployed bytecode, configuration, verifier identities and operators. *(second Claude account, branch `bhoumik/release-ops-2`)*
- [~] Reconcile docs and user-facing claims with release behaviour. README now covers running the stack, the page flow and test tiers; DEMO.md and HANDOFF.md still need a final pass.
- [ ] Release handoff, demo and submission evidence.
