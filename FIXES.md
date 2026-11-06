# Product fixes: fill rate, waiting and usability

A self-contained brief for whoever picks up this work, human or agent. It says what is wrong with the trading experience, the evidence, where in the code each problem lives, what to change and how to verify it. Read [AGENTS.md](AGENTS.md) first (setup, lanes, rules), then this.

**Goal:** trading through Blindfold should be about as seamless as a normal swap, while keeping the promised privacy (sealed orders) and safety (a user's limit is always enforced; funds can always be recovered permissionlessly).

**Status on 2026-11-07:** fixes 1 and 2 are implemented in open PRs. Everything from fix 3 on is proposed, not built.

| # | Fix | Lane | Status |
|---|---|---|---|
| 0 | Measure fill, unfilled and expiry rates on real order flow | Kritarth | PR [#76](https://github.com/kodykebab/blindfold/pull/76) |
| 1 | Oracle latest-trade check rejects quiet pools | Kritarth | PR [#77](https://github.com/kodykebab/blindfold/pull/77) |
| 2 | Proving margin and near-deadline orders | Kritarth + Khush | PR [#78](https://github.com/kodykebab/blindfold/pull/78) |
| 3 | A slow or missing solver expires batches | Kritarth + Khush | proposed |
| 4 | Order limits: defaults and presentation | Khush | proposed |
| 5 | Unfilled orders: one-click or automatic resubmit | Khush | proposed |
| 6 | Automatic encrypted backup of private state | Khush | proposed |
| 7 | Deployment defaults: batch length and oracle parameters | Kritarth | proposed |
| 8 | Positioning and expected cost shown up front | all | proposed |
| 9 | Larger structural limits (proving cost, one batch, venues) | all | open questions |

## How the system works today

Read this before changing anything; it is the shortest accurate summary.

**Order life cycle (proof-enforced deployment, `AdmittedSettlement`):**
1. **Fund.** The user deposits into `BlindfoldVault`. Vault balances are public.
2. **Prove locally.** The client builds two Groth16 proofs on the user's machine: a preparation that binds a fresh tlock key to the batch's drand round, and an online proof that binds the order and funding. `packages/client/admission.mjs` drives the Go prover at `packages/proof-bench/results/local-prover`.
3. **Admit.** `admit()` accepts the ciphertext only during the batch's commit window.
4. **Reveal.** The drand round comes out 6 s after commits close. Anyone reveals; the keeper does it for a bounty from the deposit.
5. **Settle.** After the reveal window, a solver calls one of three routes in `contracts/src/BlindfoldSettlement.sol`:
   - `settle()`: the residual goes through a sealed Uniswap v4 pool (`SealedPoolHook`, only the settlement can swap). It needs LPs in that pool specifically.
   - `settlePeer()`: buyers cross sellers with no pool swap, priced from the external reference.
   - `settleExternal()`: the residual goes through real Uniswap v3 pools, using `contracts/src/market/UniswapV3Market.sol` (one pool) or `UniswapV3Route.sol` (up to three hops).
6. **Expire.** If nobody settles within the settle window, anyone can call `expire()` and every input unlocks untouched.
7. **Withdraw.** The vault blocks withdrawals while the account has any open commitment.

**Guarantees:**
- A user never gets a worse rate than their limit (`minAmountOut`).
- Whether an order fills depends on the batch, so filling is not guaranteed.
- The most a user loses is the commit fee and gas.
- One active batch per account (REVIEW R10).

**External route checks,** in `UniswapV3Market.referencePrice(end)` and the settlement:
- The reference is the geometric mean price over `window` (600 s in the tests) ending at the reveal deadline.
- It must be read within `maxDelay` (30 s in the tests) of that deadline.
- Spot must be within `maxDeviationBps` (100 in the tests) of the mean.
- Harmonic liquidity must be above a floor.
- Optionally (fix 1), the newest observation must be no older than `maxObservationAge`.
- The clearing price must be within the band around the reference.
- The residual pool swap must deliver at least what the batch owes; any extra goes back to that token's recipients pro rata.

**Measured proving** on an Apple M5 with 16 GB (`packages/proof-bench/results/advance-preparation-measurements.json`, a local file):

| Step | Time | Peak memory |
|---|---|---|
| Preparation | 53–55 s | 3.3–4.4 GB |
| Online proof | 46–47 s | 3.8–4.2 GB |

The proving key (`online.pk`) is 650 MB.

## Evidence: the order-flow replay

`packages/solver/replay.mjs` (PR #76) turns a day of real Uniswap v3 swaps into Blindfold orders and settles them under the external route's rules. Each order has the swap's size and direction, a price quoted just before the swap with the fee included, and a slippage limit. Results for 2026-11-06 are in `packages/solver/benchmarks/replay-20261106.json`. With a 50 bps limit and the test parameters above:

| Pool (swaps/h) | Filled | Unfilled | Expired | Expired with the latest-trade check off |
|---|---|---|---|---|
| USDC/WETH 0.05% (231) | 90–95% | 4–8% | 0.6–1.7% | 0% |
| WBTC/WETH 0.05% (64) | 70–76% | 3–7% | 15–24% | 0% |
| UNI/WETH 0.3% (19) | 37–65% | 6–11% | 29–52% | 0% |

Each range covers 60–300 s batches and a 60 or 120 s proving margin.

- With the latest-trade check off, fills are 92–97%, 93–96% and 85–93% respectively.
- Filled orders came out a median 3–6 bps worse than the real immediate swap on USDC/WETH, and 8–18 bps worse on UNI/WETH. That is the cost of waiting: price drift, plus the uniform price paying for the pool swap.
- **Model limits:** single-range price impact (no tick crossings); the replayed swaps stay in the pool's history; much of the flow is arbitrage. It does not model solver outages, missed proving deadlines or one-active-batch conflicts.

Re-run it after any change that affects filling:
```bash
source env.sh
OBS_AGE=120,0 LEAD=120,60 BATCHES=60,120,300 SLIPPAGE=30,50,100 node packages/solver/replay.mjs
```

---

## 1. Oracle latest-trade check rejects quiet pools (PR #77)

**Problem.** `UniswapV3Market._activeSpot` reverted `StaleObservation` whenever the pool's newest observation was older than `maxObservationAge` (120 s in the tests). That check never stops a manipulator, because a manipulating swap writes a fresh observation itself. It only rejects honest quiet periods, when the pool still holds its last traded price. In the replay it caused almost every expiry.

**Change made.** `maxObservationAge = 0` turns the check off; a positive value keeps it as a per-pool policy. These checks always apply: oracle history, an initialized newest observation, the harmonic-liquidity floor, reference age, and the spot-vs-mean deviation, which is what bounds manipulation.

**Files:** `contracts/src/market/UniswapV3Market.sol`; tests in `contracts/test/UniswapV3Market.t.sol`, `UniswapV3Route.t.sol` and `ExternalEthereumFork.t.sol` (an untraded hour on the real pool).

**Left to do:** choose each production pool's value in the deployment (fix 7).

## 2. Proving margin and near-deadline orders (PR #78)

**Problem.**
- The client required a fixed 120 s left before commits close (180 s for inline proving), whatever the machine. On the measured M5 an online proof takes about 47 s.
- An order placed with less time left failed instead of going into the next batch.
- In the replay, cutting the margin from 120 s to 60 s took the median wait for 60 s batches from 196 s to 136 s.

**Change made** (`packages/client/admission.mjs`, `cli.mjs`, `flow.mjs`, `state.mjs`):
- **Measured margin.** The client records this device's proving times, the last 5 of each kind. After 3, the margin is 1.25× the slowest recent one plus `ADMISSION_INCLUSION_SECONDS` (default 15), never under 30 s. That is 74 s on the M5.
- **Roll-over.** When the current batch closes too soon, `commit` proves for the next batch (using a key prepared for it, if one exists), waits for it to open and submits.
- **Auto-select.** `prepare-admission` without a batch number picks the earliest batch it can still make.

**Left to do:**
- Keep a key prepared in the background (fix 5).
- The batch-length default (fix 7).

## 3. A slow or missing solver expires batches

**Problem.**
- **Short deadline.** The external route can only settle within `maxDelay` of the reveal deadline: `UniswapV3Market.referencePrice` reverts `StaleReference` after that. With `maxDelay` 30 s, any settle window longer than 30 s is mostly unusable for that route; the development deployments use 30–300 s settle windows.
- **Thin margin.** The solver submits up to 2 s before `settleCloses` (`packages/solver/solver.mjs`, `externalDeadline`). In practice the reference deadline comes first, so one slow RPC call or a missed block expires the batch.
- **No incentive.** Nothing pays a solver (`BlindfoldSettlement` has no solver reward), so in practice only the team's solver runs.
- **No fallback.** The keeper (`packages/keeper`) reveals, slashes and expires but never settles. If the solver is down, every batch expires.

**Proposed change.**
1. **Longer deadline.** Make `maxDelay` at least the settle window in deployment configurations. Spot must still be within `maxDeviationBps` of the reference at execution time, and that bounds how stale the reference can be.
   - Add a test that settlement late in the window still works on a fork.
   - Add a test that a large price move inside the window still reverts `PriceDeviation`.
2. **Keeper fallback.** The keeper settles any batch the solver hasn't settled after a grace period (for example half the window). Reuse `packages/solver`'s `solve`, `solvePeer` and `solveExternal`; don't copy the logic.
   - Put the shared part in one module both packages import, or have the keeper run `solver.mjs --once`.
   - Count `Finalized` as a lost race, like the keeper's existing race handling.
3. **Decide whether solvers get paid.** For example, a small fee from the batch's surplus. This is an economic change: it needs REVIEW.md and PLAN.md entries before any contract change.

**Acceptance:**
- With the solver stopped, the keeper settles a batch on a local chain.
- A late settlement inside the window passes on the Ethereum fork.
- The replay, extended with a solver delay, shows no new expiries for solver delays up to the window length.

## 4. Order limits: defaults and presentation

**Problem.** The CLI asks for `minAmountOut` directly. Users think in swaps (amount in, slippage), not uniform-price limits. A swap-like tight limit goes unfilled when the price drifts during the wait: in the replay, a 10 bps limit filled only about half of USDC/WETH orders, against 90–95% at 50 bps.

**Proposed change** (client, then the browser app in PR [#74](https://github.com/kodykebab/blindfold/pull/74) and issue #62):
1. **Quote-based limit.** `commit` accepts an amount and a slippage (default 50 bps). It derives `minAmountOut` from a fresh quote: the external market's reference, or the v3 pool quoter, with the fee included. The explicit `minAmountOut` stays as an option.
2. **Wording.** Present the order as "you get at least X, or keep your funds". Show the expected cost of waiting from the replay (fix 8).
3. **Refuse stale quotes.** Refuse a quote older than a few seconds (issue #19 asks for stale-quote handling).

**Acceptance:** unit tests for limit derivation, including decimals and both directions; the CLI e2e commits through the new flow; issue #19's stale-quote and unfavourable-pool cases are tested.

## 5. Unfilled orders: one-click or automatic resubmit

**Problem.** An unfilled or expired order leaves the user with funds unlocked but no trade. Trying again means a new order, new proofs (about 100 s inline, or 47 s with a prepared key), another commit fee and another full wait.

**Proposed change.**
1. **`resubmit`.** A client command (and button) re-places the last unfilled or expired order with a fresh quote and limit, using fix 2's roll-over to target the next reachable batch.
2. **Background key.** Keep one preparation ready for an upcoming batch, so a resubmit pays only the online proof. A background helper prepares when a key is used or goes stale. Mind battery and CPU on laptops: make it opt-in, or limit it to when an order is open.
3. **Decide whether a resubmit after an unfilled order pays the commit fee again.** The fee exists to price spam (REVIEW R3/S3). Any refund needs an economic argument recorded in REVIEW.md.

**Acceptance:**
- An e2e test where an order goes unfilled, then `resubmit` admits it into the next batch with the prepared key.
- The background preparation never reuses a key across batches, and exports never include it (an existing invariant in `state.mjs`).

## 6. Automatic encrypted backup of private state

**Problem.** Orders, salts and funding openings live only on the device (`packages/client/.state`). A user who loses that state can't reveal their own order: a keeper must reveal it, or the commitment is released or slashed. They also can't append to their funding root without restoring an export. Today the export is manual (`export-state`).

**Proposed change.**
- After the first commit, and after every state change, write an encrypted export to a location the user chooses.
- Encrypt with a key derived from a passphrase or a wallet signature, so a backup stored somewhere untrusted reveals nothing.
- `import-state` already validates entries against their hashes and the chain. Keep that, and add decryption.
- Never include ready preparation keys or proving timings. `exportState` already leaves both out.

**Acceptance:**
- Round trip: commit, delete local state, restore from the encrypted backup, reveal and withdraw.
- A tampered or foreign backup is refused.
- The file is written with owner-only permissions.

## 7. Deployment defaults: batch length and oracle parameters

**Problem.**
- **No deploy script.** There is no `DeployBlindfold` script (`contracts/script/` holds only `DeployCourt.s.sol`), so the defaults that decide the user experience live only in test fixtures: 300–900 s development batches, `maxObservationAge` 120, `maxDelay` 30, `maxDeviationBps` 100.
- **S18 checks have no home.** S18's deployment-time checks (issue #24, PR #72) wait for that script.

**Proposed change.**
1. **Add `contracts/script/DeployBlindfold.s.sol`.** It deploys the vault, verifiers, settlement, mined hook and market or route, and writes `deployments/blindfold.local.json`, following `DeployCourt.s.sol` and the PLAN.md seams.
2. **Starting defaults, from the replay:**
   - batch length 60 s, if the client's measured margin allows it; otherwise 120 s;
   - `maxObservationAge` 0;
   - `maxDelay` at least the settle window (fix 3);
   - `maxDeviationBps` 100;
   - window 600 s.

   Record the reasoning and replay figures in REVIEW.md.
3. **Deployment checks.** Add S18's checks for what a constructor can't verify: the hook mined against the settlement, the pool initialized, and the market's tokens and settlement.

**Acceptance:** the script deploys on plain anvil and on a fork; the client, keeper and solver e2e tests run against its output instead of ad-hoc fixtures (that also starts issue #64's clean-clone gate).

## 8. Positioning and expected cost shown up front

**Problem.** Waiting costs a median 3–6 bps on a deep pool and 8–18 bps on a thin one. For a small trade that nobody would sandwich, a direct swap through a private RPC is cheaper. Selling Blindfold as a general swap replacement disappoints exactly those users.

**Proposed change.**
- Before submitting, show the expected cost of waiting and the protection it buys.
- Recommend Blindfold for larger orders and pairs where sandwiching is common.
- The haveibeensandwiched page (`app/haveibeensandwiched`) can show a user their own historical losses, which makes the case concrete.
- Update CONTEXT.md's pitch to match.

**Acceptance:** the client and app show the estimate; CONTEXT.md and the demo script state when Blindfold is and isn't the better choice.

## 9. Larger structural limits (open questions)

These need a decision before code. Record each decision in REVIEW.md or PLAN.md.

- **Proving cost.** About 47 s and about 4 GB per order rule out phones and weak laptops.
  - Options: a native desktop helper (PR #74 runs the CLI behind a loopback service), circuit work to cut proving time, or a different admission design. Issue #60 tracks device timing; R6 tracks advance preparation.
  - A browser-only (WASM) prover is unlikely at this memory size.
- **One active batch per account (R10).** A user can't place a second order, or withdraw, while one is open. Lifting it needs a rule that stops one balance backing two batches.
- **Sealed pool liquidity.** `settle()` needs LPs in a pool only batches can trade, and nothing attracts them. Either design LP incentives or treat the sealed pool as an optimization, with peer and external routes as the default.
- **Aqua.** `contracts/src/swapvm/SealedClearing.sol` exists and its quoting was fixed in PR #72. But nothing in the settlement, solver or global auction routes through Aqua (issue #26, S20). Either wire a real token-moving Aqua route or drop it from the release.
- **Public Uniswap v4 pools.** These aren't a venue: only a v3 adapter exists. A v4 market adapter would add depth on chains where v4 dominates.
- **Deposit guidance.** Vault balances are public, so an account holding only token0 reveals that it can only sell. Tell users to hold both sides if direction privacy matters.

## Verifying any of this

```bash
source env.sh
git submodule update --init --recursive && (cd contracts/lib/swap-vm && npm install --ignore-scripts)
cd contracts && forge test --fuzz-runs 4096                    # contracts, forks included
forge build --sizes src                                         # EIP-170: AdmittedSettlement is the closest to the limit
forge build --no-dynamic-test-linking                           # artifacts the package e2e tests deploy
```

Package tests:
- Run `npm ci --ignore-scripts && npm test` in each package. Set `CLIENT_E2E=1`, `KEEPER_E2E=1`, `SOLVER_E2E=1` or `RUN_GLOBAL_INTEGRATION=1` for the end-to-end tests.
- Real-proof tests also need `ADMISSION_PARAMS`, `ADMISSION_PROVER` and `ADMISSION_MANIFEST_SHA256` (see `packages/client/README.md`).
- The solver's e2e also needs its fixture built (see `packages/solver/README.md`).

Every change keeps `forge test` green and adds a test (AGENTS.md).
