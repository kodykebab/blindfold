# User stories

These stories define observable product behavior and acceptance criteria for Blindfold and Court. Implementation sequencing and ownership live in [PLAN.md](PLAN.md); implementation status lives in [HANDOFF.md](HANDOFF.md).

The primary journey is a trader using one supported token pair: review an order → fund → prepare and prove → submit → reveal → settle → reuse proceeds or withdraw. The same outcomes apply to the CLI and the browser experience. Court has a separate journey and acceptance boundary.

## Traders

### T01 — Choose the account and market

**As a trader, I want to see which account, network and token pair I am using, so that I trade in the intended market.**

- The account, network, deployment and supported pair are identifiable before funding or submission.
- Buy and sell identify the input and output tokens, with amounts shown in their token units.
- An incompatible network or deployment prevents submission and identifies the correction needed.

### T02 — Understand my balances

**As a trader, I want wallet, available, reserved and withdrawable balances shown separately, so that I know what I can spend or take out.**

- Wallet holdings are distinguished from assets held in the vault.
- Open commitments and revealed input locks are reflected in availability and withdrawal eligibility.
- When withdrawal is blocked, the account's blocking commitments and the next eligible cleanup actions are shown.

### T03 — Set an acceptable trade

**As a trader, I want a fresh quote and an explicit minimum output, so that I control the price I accept.**

- I can use a quote with a selected slippage allowance or enter an explicit minimum output.
- Before submission, the input amount, output token, minimum output and target batch are shown.
- An unavailable or stale market reference is reported instead of being presented as a current quote.
- The review distinguishes an indicative quote from the minimum-output condition enforced on execution.

### T04 — Understand the cost and wait

**As a trader, I want to review fees, deposits, gas estimates and timing, so that I can decide whether the order is worthwhile.**

- The nonrefundable commitment fee and the refundable deposit are shown separately.
- The review explains that successful reveal pays a bounty from the deposit and returns the remainder to me.
- Gas estimates identify their units and covered actions; an unavailable estimate is not displayed as zero cost.
- Commit, reveal and settlement deadlines are shown for the selected batch, with estimates distinguished from guarantees.

### T05 — Fund the order without guessing

**As a trader, I want the client to calculate the required approvals and deposits, so that I can fund an order correctly.**

- Preflight accounts for the input, deposit, commitment fee and prior cumulative reservations in each asset.
- Existing vault balances and allowances reduce the required funding actions.
- A dry run shows shortfalls and planned transactions without sending them.
- Insufficient funding or an incompatible open batch is reported before proof generation or submission.

### T06 — Prepare before choosing my order

**As a repeat trader, I want to prepare ahead of time, so that placing an order requires less work after I choose its amount and limit.**

- Preparation identifies the account, deployment, target batch and release round it belongs to.
- The client shows whether a compatible preparation is ready, being generated, consumed or expired.
- Proof timing information guides batch selection; if the current batch cannot be reached, the next target and its wait are explained.
- Keeping a preparation ready is an explicit action that can be stopped when I finish trading.

### T07 — Submit a proof-backed encrypted order

**As a trader, I want my order accepted without publishing its plaintext before the release round, so that other traders cannot read it from my submission.**

- On an enforced deployment, acceptance requires proofs binding the ciphertext, order, account, deployment, round and funding transition.
- The submission publishes ciphertext rather than the plaintext order; the fixed fee and deposit remain visible costs.
- Proof generation and transaction submission have distinguishable progress and failure states.
- A rejected proof leaves no accepted commitment, charged commitment fee or advanced funding root.

### T08 — Place several orders in one batch

**As a trader, I want to place multiple orders using the same funded account, so that I can express more than one trading intention.**

- Each accepted order advances the account's cumulative private funding state.
- Previously committed inputs are included when checking capacity for the next order.
- A stale private state or an open commitment in another batch prevents an unsafe append.
- When all commitments close, the next admission starts from the canonical empty funding state.

### T09 — Resume an interrupted submission

**As a trader, I want to recover after closing the client or losing a connection, so that I neither lose an order nor submit it twice.**

- The order, salt and pending funding transition are saved before submission.
- Resume reconciles saved state against the chain before deciding whether another submission is appropriate.
- Repeating resume after confirmed inclusion does not create another commitment.
- If the saved state cannot be reconciled, the client identifies the restoration or cleanup action required.

### T10 — Let someone else reveal my order

**As a trader, I want my accepted order to progress while I am offline, so that I do not have to keep a device running through the reveal window.**

- After the target drand round is available, a keeper can decrypt and reveal an accepted order without my private state or signature.
- The contract checks the revealed order against its commitment and owner before accepting it.
- The revealer receives the configured bounty, and the owner receives the remaining deposit for a funded reveal.
- If the automated keeper is unavailable, the client exposes the eligible manual reveal or cleanup action.

### T11 — Understand the result of a batch

**As a trader, I want to see whether my order filled fully, partially or not at all, so that I can reconcile the outcome with my limit and balances.**

- Tracking distinguishes committed, revealed, filled, partially filled, unfilled, expired and released outcomes.
- A fill shows actual input spent, output received, the clearing price and the settlement transaction.
- A partial fill respects the rounded proportional minimum for the executed input; it is not displayed as a full fill.
- Unspent input becomes available after the commitment closes, and proceeds appear in the vault.
- The outcome accounts separately for trading proceeds, commitment fees and reveal bounties.

### T12 — Recover when an order does not settle

**As a trader, I want a clear way to close unsuccessful orders, so that funds do not stay locked indefinitely.**

- Before a deadline, the client explains which action must wait and when it becomes eligible.
- An unsettled revealed batch can be expired after its settlement deadline, releasing its input locks.
- An unrevealed admitted commitment releases its deposit after the reveal window; its commitment fee remains charged.
- Tracking distinguishes that release policy from slashing on an unchecked deployment.
- Repeating cleanup after completion does not send unnecessary transactions.

### T13 — Try an unsuccessful order again

**As a trader, I want to resubmit an unfilled or expired order, so that I can try again without rebuilding it manually.**

- The client identifies the original order and the new target batch.
- A fresh market quote is used where configured, with an explicit option to retain the previous limit.
- The new commitment fee is disclosed, and all funding, timing and proof checks run again.
- Tracking links the replacement to the original and prevents accidental repeated resubmission of that original.

### T14 — Reuse proceeds or withdraw

**As a trader, I want to choose between trading again and withdrawing, so that I control when assets leave the vault.**

- Settled proceeds can fund another order without an unnecessary round trip through my wallet.
- Withdrawal shows the amount available and explains any open-commitment blockers.
- After eligible cleanup, withdrawal transfers the requested supported asset to my wallet and updates the vault balance.
- A partial withdrawal and an all-available withdrawal use the same eligibility checks.

### T15 — Restore my trading state on another device

**As a trader, I want an encrypted backup of my orders and private funding state, so that I can resume trading after losing or replacing a device.**

- State-changing commands create an encrypted backup when backup is enabled; failures are reported.
- I can place backups in a chosen synced or external location and request a backup explicitly.
- Restore authenticates the backup's account and deployment context, then validates its orders and funding state against the chain.
- Tampered, mismatched or stale state is rejected rather than silently overwriting a valid active state.
- The backup description distinguishes saved trading state from preparation keys and timing records that must be recreated.

## Service operators

### O01 — Reveal and clean up within a budget

**As a keeper operator, I want to discover due work and execute it within a spending budget, so that I can keep batches moving predictably.**

- The service waits for the correct beacon round and sends only eligible reveal or cleanup actions.
- A duplicate reveal or cleanup completed by another actor is handled as a lost race.
- Budget exhaustion and a low wallet balance stop spending and identify skipped work.
- Status reports distinguish waiting, completed work, lost races, skipped work and errors, and preserve configured spending state across restarts.

### O02 — Settle executable batches

**As a solver operator, I want to find and submit a valid clearing proposal, so that users' eligible orders execute against available liquidity.**

- Search uses the configured market and the deployment's settlement interfaces.
- A candidate is simulated, then checked again against current state before submission.
- A successful transaction records fills, the clearing price and the execution route.
- Invalid prices, insufficient output and failed route execution leave the batch's funds and locks intact.
- A bounded search that finds no candidate reports that result without claiming mathematical infeasibility.

### O03 — Settle when the primary solver is absent

**As a keeper operator, I want a fallback after the solver's grace period, so that an otherwise executable batch can still settle.**

- Inside the grace period, the keeper leaves settlement to the primary solver.
- After the grace period, it invokes the existing solver CLI using its configured account and gas budget.
- A batch settled by another actor is handled without a duplicate successful settlement.
- The configured oracle age and delay checks remain enforced during fallback.
- If settlement remains unavailable, users can follow the ordinary expiry and withdrawal path.

### O04 — Operate a verifiable deployment

**As a deployment operator, I want consistent contracts, parameters and service configuration, so that clients and operators act on the same auction.**

- Deployment records identify the chain, contract addresses, supported assets and admission parameter manifest.
- Clients and services use generated contract interfaces and the deployment records.
- Deployment checks cover contract-size limits, token configuration, timing alignment and compatible oracle/settlement windows.
- A clean-clone acceptance run covers funding, actual proof admission, reveal, settlement, cleanup and withdrawal with the intended services.

## Court participants

Court stories are independent of admission and auction settlement. They apply to the configured coverage policy, supported pools and source chain.

### C01 — Understand protection before using an RPC

**As a trader using a protected RPC, I want a signed receipt describing my coverage, so that I know who can collect and what is covered.**

- The receipt identifies the transaction, chain, beneficiary, coverage window and payout cap.
- The coverage terms distinguish a capped, profit-based payout from reimbursement of all trading loss.
- Receipt validity and supported-pool eligibility can be checked before a claim is presented as payable.

### C02 — Submit sandwich evidence

**As a watcher, I want to submit verifiable evidence for a covered transaction, so that a qualifying incident can be registered onchain.**

- The evidence authenticates the relevant block, transactions, receipts and swap participants.
- The verifier checks the supported sandwich predicate and the receipt's coverage conditions.
- Duplicate evidence does not reserve or pay the same coverage twice.
- Detection or suspicion is distinguishable from an accepted onchain claim.

### C03 — Follow and collect a claim

**As a covered beneficiary, I want to follow my claim through its collection window, so that I can collect the amount allocated to me.**

- Claim registration, the incident budget, collection timing and the beneficiary's allocation are visible.
- Multiple eligible claims share the incident budget according to the registry's allocation rules.
- Collection pays only the beneficiary's eligible amount and cannot be repeated for the same entitlement.
- The result identifies the actual payout and transaction, separately from the receipt's maximum cap.

### C04 — Manage an RPC's bond

**As a protected RPC operator, I want to monitor my bond and coverage obligations, so that I can fund service commitments and plan withdrawals.**

- Available bond, reserved coverage and claim-related payments are distinguishable.
- Coverage and claims follow the registry's configured chain and pool policy.
- Unbonding observes the configured delay and does not bypass reserved obligations.

## Broader auction scope

### G01 — Trade across a supported token registry

**As a multi-token trader, I want compatible orders across different pairs to settle atomically, so that opposing flows can be matched through a shared auction.**

- The deployment identifies its supported token registry, price references and registered routes.
- Private funding accounts for cumulative reservations across the supported assets.
- A settlement verifies each executed order's limit and the batch's asset accounting as one atomic operation.
- An unavailable market does not falsely report a fill; failed settlement preserves funds and the ordinary recovery path.
- This journey has its own proof, solver, custody and end-to-end acceptance evidence.

## Acceptance scenarios

| Scenario | Stories | Evidence to capture |
|---|---|---|
| First trade through withdrawal | T01–T07, T10–T11, T14 | Reviewed limit and costs, accepted proof, decrypted order, fill, fee/bounty accounting, wallet receipt |
| Repeat trading in one batch | T06, T08, T14 | Preparation use, cumulative roots, funding checks, reuse of vault proceeds |
| Interrupted submission and device restore | T09, T15 | Durable pending state, reconciliation, authenticated restore, no duplicate commitment |
| Partial fill or no fill | T03, T11–T14 | Proportional minimum, actual spent/received amounts, unlocked remainder, replacement link |
| Keeper or solver outage | T10, T12, O01–O03 | Deadline handling, budget behavior, fallback attempt, expiry, successful withdrawal |
| Invalid or stale market | T03, O02–O03 | Refusal to quote or settle, preserved balances and locks, valid retry or expiry |
| Covered sandwich | C01–C04 | Signed receipt, authenticated evidence, accepted claim, budget allocation, beneficiary collection |
| Multi-token batch | G01 | Cross-asset funding proof, atomic accounting, route execution, independent recovery checks |

## Implementation references

- [Client workflow](packages/client/README.md): balances, quotes, funding, preparation, submission, backup and recovery.
- [Solver](packages/solver/README.md): clearing search, execution routes and the real-proof CLI acceptance test.
- [Keeper](packages/keeper/README.md): reveal, cleanup, budgets and fallback settlement.
- [Architecture](ARCHITECTURE.MD): custody, admission, settlement and Court trust boundaries.
- [Product and release plan](PLAN.md): ownership, browser delivery, integrations and acceptance sequencing.
