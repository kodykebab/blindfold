# PLAN.md

Who builds what, in three phases, so three people can work **asynchronously** without waiting on each other, and anyone can test **everything** on their own laptop between phases. Rules: [AGENTS.md](AGENTS.md). Design: [CONTEXT.md](CONTEXT.md), [ARCHITECTURE.MD](ARCHITECTURE.MD). Flaws referenced as R1–R9: [REVIEW.md](REVIEW.md).

Tick your own boxes as you merge. **Must** items are never cut.

## Team and lanes
Each lane is a vertical slice with its own local check, and each prize has one owner.

| Who | Lane | Prize | Owns (edit freely) |
|---|---|---|---|
| **Kritarth** | Blindfold onchain + admission proofs: contracts, deploy, Aqua, prover | Uniswap (hook + settlement), 1inch | `contracts/src/{BatchAuction,BlindfoldVault,BlindfoldSettlement,SealedPoolHook}.sol`, `contracts/src/admission/`, `contracts/src/swapvm/`, `contracts/script/{DeployBlindfold,SeedBatch}.s.sol` (+ other Blindfold scripts), `contracts/test/{Blindfold,BlindfoldUnichainFork,ReservationModel}.t.sol` and other Blindfold tests, `contracts/test/swapvm/`, `packages/proof-bench/`, `ARCHITECTURE.MD`, `FEEDBACK.md` |
| **Bhoumik** | Court, bonds, solver, demo, local runners | Uniswap (Court) | `contracts/src/court/` (Kritarth wrote `SandwichCourtVerifier.sol`, so Kritarth reviews changes to it), `contracts/script/DeployCourt.s.sol`, `contracts/test/court/`, `packages/{court-watcher,solver,demo-bots}/`, `scripts/` (local check and end-to-end runners), `DEMO.md` |
| **Khush** | Client, keeper, Arkiv, UI | Arkiv (+ Swarm bonus) | `packages/{arkiv,client,keeper}/`, `app/`, `arkiv/` |

Shared (small PR, tell the others): `foundry.toml`, `.gitmodules`, `.gitignore`, `env.sh`, `README.md`, `AGENTS.md`, `CONTEXT.md`, `HANDOFF.md`, `PLAN.md`, `REVIEW.md`, `contracts/test/utils/`.

### Who fixes which flaw
| R | Fix | Owner | Phase | Priority |
|---|---|---|---|---|
| R1 | Proportional partial fills across the marginal limit group | Kritarth | 1 | Must |
| R2 | `admit()` with a mock verifier (P1), real Groth16 prover (P2) · client proves and admits | Kritarth · Khush | 1–2 | Should (fallback: `ADMISSION=off`) |
| R3 | Non-refundable `commitFee` | Kritarth | 1 | Must |
| R4 | Solver settles at the band midpoint, measures the band · `settleRewardBps` | Bhoumik · Kritarth | 1–2 | Should |
| R5 | No settle in a block with a liquidity change | Kritarth | 2 | Could |
| R6 | Measure proving end to end, pick the proving mode | Kritarth | 2 | Should |
| R7 | Align `start`/`batchLength` to 3 s; document sequencer trust | Kritarth | 1 | Must |
| R8 | `BondRegistry` pays `min(profit, maxPayout)`, no floor, once per tx | Bhoumik | 1 | Must |
| R9 | Strict predicate for payouts; near-misses as public `court.suspect` | Bhoumik | 2 | Could |

---

## Working async: six rules that keep anyone from blocking
1. **Seams are frozen now, with exact signatures** ([below](#seams)). You code against the seam, never against a teammate's branch. If a seam is wrong, propose an *additive* change in a PR; don't wait for an answer to keep working.
2. **The consumer owns the fake.** If you read a seam that doesn't exist yet, write your own stand-in inside your package, then keep building. Examples:
   - a fake RPC that accepts a price band;
   - a fake prover that returns the frozen JSON;
   - `ARKIV=off`;
   - recorded drand rounds.

   A producer can never block you.
3. **Every item lists `Needs:`.** It names only things from an *earlier* phase (already on `main`) or from your own lane, and the cross-check at the end proves there are no same-phase cross-lane needs. Start an item as soon as its `Needs:` are on `main`. Phases are gates, not clock times: early finishers start their next-phase items right away.
4. **Merge small and often, behind flags.** Unfinished work stays off by default, so `main` always runs:
   - `ADMISSION=off|mock|real`;
   - `ARKIV=off|testnet`;
   - deploy-script env vars.

   Never break another lane's `npm test` or `forge test`.
5. **Everything runs in two modes on one laptop** ([Local environments](#local-environments)):
   - **local:** plain `anvil`, no keys, no testnets; internet only for drand;
   - **live:** Unichain fork, Arkiv testnet, real prover.

   Every piece must work in local mode.
6. **A phase is done when its local check passes on a clean clone of `main`**, run by anyone. Then post a short async sync note in the chat: what landed, R-items fixed, leftovers re-split. No meeting is needed.

## Seams
Additive changes only (new key, event, overload, optional attribute, CLI flag). A breaking change needs the consumers' OK and an update to this table in the same PR.

### Contracts (producer → consumers)
| Seam | Producer | Consumers | Exact shape |
|---|---|---|---|
| Existing ABIs and events | Kritarth | everyone | As in [HANDOFF.md](HANDOFF.md#interfaces-to-build-against). Read ABIs from `contracts/out/` after `forge build`; never hand-copy |
| R1 settle overload | Kritarth | solver | `settle(uint64 batchId, uint256 priceX96, uint256 marginalId, uint128 marginalAmountIn)`. `marginalId` identifies a funded representative; every same-side order with the same exact limit ratio receives the floored proportional input; if its output would violate the ceil-rounded minimum, reduce that input to a multiple of `amountIn / gcd(amountIn, minAmountOut)` instead. Zero-output allocations with zero minimum stay unfilled. Eligible better same-side limits fill fully; worse limits do not fill; opposing orders use the existing quote rule. Partial minimum output rounds up. `settle(b, p)` stays. `Filled.amountIn` = the actual filled amount. See REVIEW.md S1 implementation notes before updating the solver |
| R3 fee | Kritarth | client, UI | `commitFee() view returns (uint256)`, charged in `depositToken` on every commit and admit, never refunded |
| R2 admission | Kritarth | client, keeper | `admit(uint64 batchId, bytes32 hash, bytes ciphertext, bytes proof) returns (uint256 id)`; `admissionRequired() view returns (bool)`. `proof` is opaque bytes whose encoding Kritarth defines: one seal and journal, or the preparation and online seals and journals ABI-encoded together, after the two-proof split on `main` (`725ab8e`). The client passes it through untouched. `admit` emits the same `Committed` event, so the keeper doesn't change. When `admissionRequired`, `commit` reverts |
| R4 reward | Kritarth | solver | `settleRewardBps() view returns (uint256)`: share of the residual surplus paid to `msg.sender` of `settle` (0 until shipped) |
| Bonds | Bhoumik | demo-bots, watcher, UI (via Arkiv) | `bond()`, `requestUnbond()`, `unbond()` (delayed); `claim(SandwichCourtVerifier.Claim c, Protected r, bytes sig) returns (uint256 paid)`. EIP-712 `Protected{bytes32 txHash, uint256 chainId, uint64 acceptedAt, uint64 maxBlock, uint256 maxPayout}`; `maxPayout` comes from the tx's own slippage at acceptance |

Settlement timing: new deployments require `0 < settleLength <= floor(batchLength / 3) * 3`. This accounts for drand round quantization and ensures `settleCloses(b) <= revealCloses(b + 1)`. The former 30-second cadence / 60-second settlement configuration is rejected; use a 30-second settlement window or increase cadence. No predecessor-finalization cursor is needed.

### Files, CLIs and data
| Seam | Producer | Consumers | Exact shape |
|---|---|---|---|
| `deployments/blindfold.local.json` | Kritarth | Khush, Bhoumik | `{chainId, deployBlock, mode: "local"\|"fork", vault, settlement, hook, poolManager, token0, token1, depositToken, admission: "off"\|"mock"\|"real", admissionVerifier, admissionImageId, aquaRouter}`. Keys not shipped yet are `null` |
| `deployments/court.local.json` | Bhoumik | Khush | `{chainId, deployBlock, verifier, bondRegistry, rpcSigner}` |
| Prover CLI | Kritarth | client | `admission-prover prepare <prep.json> <state.json>`, then `admission-prover admit <in.json> <state.json> <out.json>`.<br>**Prepare** needs only `{chainId, settlement, owner, batch, round}`, so it can run before the order is chosen. It covers the key-wrapper proof (the `prepared` host on `main` splits this out).<br>**Admit** in: `{order: {owner, zeroForOne, amountIn, minAmountOut}, salt, step, prev: {total0, total1, blinding}, budget0, budget1}`. Out: `{ciphertext, hash, proof, next: {total0, total1, blinding}, root}`, where `proof` is the hex of the opaque `admit` bytes. It encrypts too, because the proofs need the tlock randomness.<br>`--mock` on either step returns seals that RISC Zero's `RiscZeroMockVerifier` accepts. The binary name is Kritarth's call; the subcommands and JSON are the seam. The client keeps its own fake until the CLI ships |
| Arkiv entities | Khush (`arkiv/schema.md`) | solver: `blindfold.batch`; watcher: `court.verdict`, `court.rpc`, `court.suspect`; client: `blindfold.commitment`; UI reads all | The table in [CONTEXT.md](CONTEXT.md#arkiv-entities), plus `court.suspect` `{victimTx, block, pool, reason}`. Attribute names exactly as written |
| `packages/arkiv` | Khush | every package | `put(type, attrs, {expiresIn})`, `query(type, where)`. `ARKIV=off` stores to `.arkiv-local/<type>.jsonl`. Until it ships, consumers append to that same file themselves |
| Package CLIs (used by `scripts/e2e.sh`) | each owner | Bhoumik (e2e), everyone | `npm test` = offline unit tests. `npm start` = long-running service. `npm start -- --once` = do all work that is due now, then exit 0. Plus `client`: `npm start -- commit-many --users 10-19 [--bad]`; `demo-bots`: `npm start -- leak-and-sandwich` |
| Anvil accounts | — | everyone | 0 deployer · 1 keeper · 2 solver · 3 watcher · 4 leaky-RPC signer · 5 sandwich bot · 10–19 users. Separate accounts so bots never collide on nonces |
| Ports | — | everyone | anvil `8545` · leaky RPC `8546` · app `3000` |

### Env vars (all have local defaults)
| Var | Default | Read by | Meaning |
|---|---|---|---|
| `RPC_URL` | `http://127.0.0.1:8545` | every package | Chain to talk to |
| `ARKIV` | `off` | every package | `off` = local JSONL files; `testnet` = Arkiv testnet (needs the team key in `.env`) |
| `ADMISSION` | `off` | deploy script, client | `off` = plain `commit`; `mock` = `admit` with the mock verifier; `real` = Groth16 |
| `TOLERANCE_BPS` / `COMMIT_FEE` / `SETTLE_REWARD_BPS` | `100` / `1e17` / `0` | `DeployBlindfold.s.sol` | Lets Bhoumik apply the R4 measurements without a code change |

---

## Local environments
Both modes run on one laptop. **Local mode needs no keys and no testnet accounts**; it still needs internet for drand (and for the fork RPC in live mode).

```bash
# local mode: plain anvil (the deploy script deploys its own PoolManager; no Aqua)
source env.sh
anvil --accounts 20 --port 8545
```
```bash
# live mode: Unichain fork (real PoolManager, Aqua, SwapVM router)
anvil --fork-url https://mainnet.unichain.org --accounts 20 --port 8545
```
```bash
cd contracts
forge script script/DeployBlindfold.s.sol --rpc-url http://127.0.0.1:8545 --broadcast   # Kritarth, Phase 1
forge script script/DeployCourt.s.sol     --rpc-url http://127.0.0.1:8545 --broadcast   # Bhoumik, Phase 1
```
**Don't time-travel a chain the keeper uses.** drand runs on wall-clock time, so `evm_increaseTime` puts chain time ahead of the drand round and reveals break. `SeedBatch.s.sol` time-travels, so run it on its own fresh anvil.

## Already done
- **Contracts:** vault, commit, anyone-reveal, slashing, padding orders; verified settle on the sealed v4 pool (local and Unichain fork); `SealedClearing` + router; Court verifier on live mainnet sandwiches.
- **Off-chain tools:** sandwich finder and proof builder; admission-proof prototype (`packages/proof-bench`) and private funding model (`ReservationModel.t.sol`).
- **Tests:** `forge test` 89/89.

---

## Phase 1: Standalone (≈ h0–12)
Every item builds against the frozen seams with its own fakes. **No Phase 1 item needs anything from another lane.** The Must flaw fixes (R1, R3, R7, R8) land here.

### Kritarth
- [ ] **`DeployBlindfold.s.sol`** · Needs: nothing.
  - **Modes:** in local mode (no code at the Unichain PoolManager address) it deploys its own `PoolManager`; on the fork it uses Unichain's.
  - **Deploys:** vault, settlement, mined hook, pool init, LP seed.
  - **Users:** mints both tokens to users 10–19.
  - **Schedule:** `start` from the chain time, rounded up so `start − DRAND_GENESIS` is a multiple of 3 (R7).
  - **Config:** reads `TOLERANCE_BPS`, `COMMIT_FEE`, `SETTLE_REWARD_BPS` and `ADMISSION`.
  - **Output:** writes `deployments/blindfold.local.json` with every key, unshipped ones `null`.
  - **Check:** fresh anvil (both modes) → script → `cast call <settlement> "currentBatch()(uint64)"` returns, and `cast block latest -f timestamp` is within seconds of `date +%s`.
- [ ] **`SeedBatch.s.sol`** · Needs: own deploy script.
  - **What it does:** one batch with plaintext commits and reveals from users 10–19, including one poison order (REVIEW R1), then time-travel into its settle window.
  - **Why:** it's the solver's live fixture.
  - **Check:** after it runs, `settle` with the marginal overload succeeds.
- [ ] **R7 alignment** · Needs: nothing.
  - **What:** the constructor requires `(start − DRAND_GENESIS) % 3 == 0` and `batchLength % 3 == 0`.
  - **Check:** a misaligned config reverts; existing tests green.
- [ ] **R3 `commitFee`** · Needs: nothing.
  - **What:** a constructor param, charged on every commit to the treasury, never refunded, and charged to padding too. It stays separate from the refundable deposit.
  - **Check:** the REVIEW R3 test, flipped into a regression test, shows stuffing now costs 64 × `commitFee`.
- [ ] **R1 marginal partial fill** · Needs: nothing.
  - **What:** the frozen `settle` overload.
  - **Rules:**
    - every other order fills iff its limit holds at `p`;
    - the marginal order fills `0 < marginalAmountIn ≤ amountIn`, only if its limit price is within `toleranceBps` of `p`;
    - the unfilled part is unlocked.
  - **Check:** the REVIEW R1 test, flipped, settles; local and fork suites green.
- [ ] **R2 `admit()` with the mock verifier** · Needs: nothing.
  - **What:** the frozen `admit`/`admissionRequired`, in `contracts/src/admission/`.
  - **Binds the journal to current state:**
    - `chainId`, `settlement`, `msg.sender`;
    - `currentBatch()`, `targetRound(b)`;
    - `openCommitments(msg.sender)`, `root[msg.sender]`;
    - the ciphertext digest.
  - **Then:**
    - checks the budgets against free balances after the deposit and fee;
    - charges both;
    - updates the root;
    - emits `Committed`.
  - **Verifier:** an `IRiscZeroVerifier` set at deploy; `RiscZeroMockVerifier` when `ADMISSION=mock`.
  - **Two proofs:** if the preparation/online split stays, `admit` decodes both from `proof`, verifies each against its own image ID, and checks their shared binding.
  - **Tests:** port the `ReservationModel` tests to it.
  - **Check:** a mock seal for a valid journal admits. A tampered journal, a stale root, the wrong round and an insufficient budget all revert. With `admissionRequired`, `commit` reverts.
- [ ] **Prover CLI `--mock`** · Needs: nothing.
  - **What:** `prepare --mock` and `admit --mock` take the frozen JSON, encrypt with real tlock, and emit mock seals plus the real journals inside `proof`.
  - **Check:** the output admits on a local deploy with `ADMISSION=mock`.

### Bhoumik
- [ ] **`BondRegistry.sol` + tests (R8)** · Needs: nothing (the verifier exists).
  - **The frozen ABI:** `bond`, a delayed `unbond`, and `claim`.
  - **`claim` requires:**
    - `verdict.victimTxHash == r.txHash`;
    - the block is ≤ `maxBlock`;
    - the chain matches `r.chainId` (local path = `block.chainid`, anchored path = 1);
    - the RPC's signature is valid;
    - this tx hasn't been paid before.
  - **Payout:** `min(valued profit, maxPayout) + prover gas`. No floor.
  - **Decide first:** the bond asset and how profit is valued in it; write it in CONTEXT.md "Court design".
  - **Check (offline):** `forge test --match-path 'test/court/*'` with a test RPC key signing receipts for the `v3.json`/`v4.json` fixtures. Include:
    - a self-sandwich case that pays no more than `maxPayout`;
    - a replay that reverts.
- [ ] **`DeployCourt.s.sol`** · Needs: own BondRegistry.
  - **Deploys:** the verifier (`l1Block = address(0)` locally) and `BondRegistry`, with account 4 bonded.
  - **Output:** writes `deployments/court.local.json`.
  - **Check:** both modes → `cast call <bondRegistry> ...` shows the bond.
- [ ] **`packages/solver` v1 (R4)** · Needs: nothing (fake RPC).
  - **Discovery:** reads `blindfold.local.json` and finds settleable batches from the schedule views and `Revealed` events.
  - **Pricing:**
    - finds the feasible band `[lo, hi]` with `eth_call`;
    - settles at its midpoint;
    - uses the R1 overload when no price fills everyone fully.
  - **Modes:** `npm start` and `--once`.
  - **Check:** `npm test` against a fake RPC with a known band, including a poison case.
- [ ] **court-watcher configurable** · Needs: nothing.
  - **What:** `ETH_RPC` and `V4_POOL_MANAGER` env vars (today `lib.mjs` hardcodes Ethereum mainnet's), so it can scan the local chain.
  - **Check:** `N=300 node find.mjs` still finds mainnet sandwiches with the defaults.
- [ ] **`scripts/check.sh`** · Needs: nothing.
  - **What it runs:**
    - `forge test`;
    - `npm test` in every `packages/*` that has a `package.json` (auto-discovered, so nobody else edits the script);
    - the proof-bench `cargo test` if Rust is installed.
  - **Output:** one pass/fail line per part; it exits non-zero on any failure.
  - **Check:** it runs green on `main`.

### Khush
- [ ] **`packages/arkiv` + `arkiv/schema.md`** · Needs: nothing.
  - **What:** a thin wrapper over `@arkiv-network/sdk`, with `ARKIV=off` as the default backend.
  - **Schema:** copied from CONTEXT.md plus `court.suspect`, then frozen.
  - **Check:** `npm test` (put → query round trip, offline).
- [ ] **`packages/client` tlock** · Needs: nothing.
  - **What:** encrypt `abi.encode(order, salt)` to a quicknet round with `tlock-js`, and decrypt once the round is out.
  - **Check:** `npm test`, offline, against a recorded past round and its signature (fixtures in the package).
- [ ] **`packages/client` order building + fake prover** · Needs: nothing.
  - **Hashes and salts:** `orderHash` computed locally (`keccak256(abi.encode(chainId, settlement, batchId, order, salt))`), with fresh random salts.
  - **Budgets:** set to the full free balances (R2 privacy).
  - **Prover:** a built-in fake prover that matches the frozen CLI JSON. The client calls `prepare` as soon as the batch is known, then `admit` once the order is set, and passes `proof` through untouched.
  - **Modes:** `ADMISSION=off|mock|real` selects `commit` or `admit`.
  - **Check:** `npm test` reproduces a hash vector made with `cast abi-encode` + `cast keccak`.
- [ ] **`packages/keeper` offline** · Needs: nothing.
  - **What it does:**
    - discovers work from `Committed` events (Arkiv comes in Phase 2);
    - fetches the drand signature and decrypts;
    - builds the `reveal`, `slashUnrevealed` and `expire` calls;
    - schedules them from the schedule views.
  - **Modes:** `npm start` and `--once`.
  - **Check:** `npm test` with recorded drand rounds and a fake RPC.
- [ ] **`app/` shell (Next.js)** · Needs: nothing.
  - **Views:** batch view, mempool view and Court ledger (verdicts and suspects).
  - **Data:** reads `packages/arkiv`, with seed rows that match the schema.
  - **Check:** `ARKIV=off npm run dev` shows all three views with seed data.
- [ ] **Accounts:** an Arkiv access key and faucet tGLM for a team wallet (in `.env`); ask about a Swarm postage batch.

### Phase 1 local check (anyone, clean clone of `main`)
```bash
source env.sh && scripts/check.sh                                   # every unit test, every lane
anvil --accounts 20 &                                               # local mode
cd contracts
forge script script/DeployBlindfold.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
forge script script/DeployCourt.s.sol     --rpc-url http://127.0.0.1:8545 --broadcast
ADMISSION=mock forge script script/DeployBlindfold.s.sol --rpc-url http://127.0.0.1:8545 --broadcast   # admit on: the prover's --mock output must admit
```
Then, on a **separate fresh anvil**: `SeedBatch.s.sol` → `(cd packages/solver && npm start -- --once)` settles the seeded batch, including the poison order. REVIEW.md marks R1, R3, R7 and R8 fixed.

---

## Phase 2: Wired (≈ h12–24)
Swap the fakes for the real pieces. Every `Needs:` below is either Phase 1 work (on `main`) or your own lane.

### Kritarth
- [ ] **Real prover (R2)** · Needs: own `admit` and `--mock`.
  - **What:** `prepare` and `admit` without `--mock` prove and wrap to Groth16, with the same JSON.
  - **Deploy:** `ADMISSION=real` points at the RISC Zero verifier and the admission image ID.
  - **Check:** a real seal admits on the fork; the client needs no code change.
- [ ] **R6 measurement** · Needs: own real prover.
  - **What:** time execute, prove, Groth16 wrap and onchain verify, end to end on a laptop, for both guest variants. Time the preparation and online proofs separately.
  - **Then:** pick the proving mode and write it in ARCHITECTURE.MD and REVIEW R6. For example: prepare before the batch opens, and prove the online part inside the commit window.
- [ ] **Aqua strategy (1inch hard requirement)** · Needs: own deploy script.
  - **What:** a ship script plus a fork test where `BlindfoldAquaRouter` fills at `activeClearingPriceX96` with real token transfers (taker = settlement).
  - **Deploy:** live mode ships and funds the strategy, and writes `aquaRouter`.
- [ ] **Aqua leg in `settle`** · Needs: own Aqua strategy.
  - **What:** split the residual between the sealed v4 pool and Aqua through `SealedClearing`, keeping the marginal-price check.
  - **Check:** local and fork tests.
- [ ] **R4 `settleRewardBps`** · Needs: nothing.
  - **What:** pay the frozen reward from the surplus.
  - **Config:** the default comes from `SETTLE_REWARD_BPS`, so Bhoumik's measured value applies without a code change.
- [ ] (Could) **R5 liquidity lock** · Needs: nothing.
  - **What:**
    - add `beforeAddLiquidity`/`beforeRemoveLiquidity` to the hook;
    - record the last block with a liquidity change;
    - `settle` reverts in that block;
    - re-mine the hook.
  - **Check:** a contract that adds liquidity, settles and removes it in one tx reverts.

### Bhoumik
- [ ] **Solver as a service** · Needs: Kritarth's P1 deploy, `SeedBatch`, R1 overload; Khush's P1 `packages/arkiv`.
  - **What:** settles every batch as its settle window opens, and writes `blindfold.batch`.
  - **Check:** both modes, against `SeedBatch`.
- [ ] **R4 band measurement** · Needs: Kritarth's P1 deploy and `SeedBatch`.
  - **What:** a script that records the feasible band and how much value it moves, for net-sell, net-buy, balanced and 64-order batches.
  - **Output:**
    - the numbers go in REVIEW R4;
    - a recommended `TOLERANCE_BPS`/`SETTLE_REWARD_BPS`, applied through the deploy env vars (no Kritarth code change).
- [ ] **Malicious-solver script** · Needs: Kritarth's P1 deploy and `SeedBatch`.
  - **What:** a price outside the band reverts (demo step 4).
- [ ] **`packages/demo-bots`** · Needs: own P1 `DeployCourt`.
  - **Leaky RPC:** a "protected" RPC on `:8546`. It signs `Protected` with `maxPayout` taken from the tx's slippage, then leaks the tx.
  - **Sandwich bot:** works on a normal (no-hook) v4 pool it deploys itself. It uses `token0`/`token1` from `blindfold.local.json` if present, and its own tokens otherwise.
  - **Command:** `npm start -- leak-and-sandwich`.
- [ ] **Watcher service** · Needs: own BondRegistry and demo-bots; Khush's P1 `packages/arkiv`.
  - **Pipeline:** new block → sandwich of a receipted tx → claim (BLOCKHASH path on anvil, AGENTS.md gotcha 5) → `BondRegistry.claim`.
  - **Writes:** `court.verdict` and `court.rpc`.
  - **R9:** near-misses go out as `court.suspect`, with no payout.
  - **Modes:** `npm start` and `--once`.
- [ ] **`scripts/e2e.sh`** · Needs: every lane's P1 work on `main`.
  - **What:** runs the integration target below, step by step, through each package's frozen CLI. `MODE=local` (default) or `MODE=live`.
  - **Output:** each step prints pass/fail, and the script stops at the first failure, naming the owning lane.
- [ ] **R9 write-up** · Needs: nothing.
  - **What:** a PR to Kritarth adding the strict-vs-recall trade-off to ARCHITECTURE.MD §10.

### Khush
- [ ] **Client commit flow on a chain** · Needs: Kritarth's P1 deploy, `admit`, `--mock` CLI.
  - **Steps:** vault deposit of both tokens → commit (`ADMISSION=off`) or prover CLI → `admit` (`mock`/`real`) → write `blindfold.commitment`.
  - **`real` mode:** the same code path, flipped by flag once Kritarth's real prover lands, so it never blocks this item.
- [ ] **`commit-many` (demo step 2)** · Needs: own commit flow.
  - **What:** users 10–19 commit to the current batch, and `--bad` adds one bad commitment:
    - garbage ciphertext in `off` mode;
    - a rejected `admit` in `mock`/`real` mode.
- [ ] **Keeper on a chain** · Needs: Kritarth's P1 deploy.
  - **What it does:**
    - discovers work through Arkiv, falling back to `Committed` events;
    - reveals;
    - `slashUnrevealed` after the reveal window;
    - `expire` after the settle deadline, so no user stays locked.
- [ ] **Live Arkiv** · Needs: own P1 Arkiv key and package.
  - **What:** `ARKIV=testnet` backend; the UI reads live entities. Seed your own test entities so the UI doesn't wait for the solver or watcher.
- [ ] (Could) **Swarm** · Needs: own client.
  - **What:** ciphertext to Swarm, with `ctRef` in the commitment.

### Phase 2 local check: integration target (anyone, clean clone)
`scripts/e2e.sh` in `MODE=local` (plain anvil, `ARKIV=off`, `ADMISSION=mock`), then `MODE=live` (Unichain fork, `ARKIV=testnet`, `ADMISSION=real`):
1. Deploy both systems → `commit-many --bad`.
2. The keeper reveals and slashes, or the bad `admit` is rejected.
3. The solver settles at the band midpoint, including a poison order through the marginal fill. In live mode the residual goes through v4 and Aqua.
4. `leak-and-sandwich` → the watcher claims → the victim is refunded, at most `maxPayout`. A self-sandwich claim pays no more than its cap.
5. The UI shows the batch, the verdict and a suspect (from local files, or from Arkiv testnet in live mode).

---

## Phase 3: Demo and submission (≈ h24–36, feature freeze at h30)
Every `Needs:` here is Phase 2 on `main`.

### Kritarth
- [ ] `FEEDBACK.md` and the Uniswap developer feedback form.
- [ ] README: exact contract and line pointers for the Uniswap parts (hook, settlement) and the 1inch parts (`SealedClearing`, router, strategy).
- [ ] ARCHITECTURE.MD updated for what landed (R1, R2, R3, R5, R7) and the measured proving mode (R6).
- [ ] Rehearse demo step 4 with real token transfers through Aqua.
- [ ] 1inch booth question (see HANDOFF.md).

### Bhoumik
- [ ] `DEMO.md`: built on `scripts/e2e.sh MODE=live`, with the terminal layout for demo steps 1–6.
- [ ] (Should) Court on Base: deploy, a live `checkpoint()`, and one anchored claim on a fresh mainnet sandwich. Build the proof within about 25 minutes (AGENTS.md gotcha 6). Fallback: a Base fork.
- [ ] README: Court line pointers. Rehearse demo steps 1 and 5.
- [ ] CONTEXT.md corrections: the payout formula (R8), the solver claim (R4), the timing margin (R7), the free-option wording (R2), team size.
- [ ] Uniswap booth question.

### Khush
- [ ] UI polish for demo steps 1–3 and 6.
- [ ] `arkiv/{schema,friction,reach,why-arkiv,how-you-use-arkiv}.md`; wallet addresses and a runnable query in the README.
- [ ] HANDOFF.md status table refreshed from what's on `main`.
- [ ] Arkiv booth question.

### Everyone
- [ ] Mark your R-items fixed or open in REVIEW.md, and decide together whether REVIEW.md stays in the submitted repo (AGENTS.md "Repo" rules).
- [ ] Two clean `DEMO.md` rehearsals from a clean clone, each run by a different person.
- [ ] Video (4 min, CONTEXT.md demo script); each person records their own steps.
- [ ] Submission form; check every prize's hard requirements in CONTEXT.md once more.

### Phase 3 local check
A teammate who didn't write `DEMO.md` follows it on a clean clone and gets through all six demo steps without help.

## If we fall behind
Cut in this order, and never cut a Must (R1, R3, R7, R8, the Aqua fill with real transfers, Arkiv writes and reads):
1. Swarm.
2. R5 liquidity lock.
3. Court on live Base (stay on the fork).
4. The Aqua leg inside `settle` (keep the standalone Aqua fill, which 1inch requires).
5. R9 suspects.
6. `ADMISSION=real` (demo with `mock`).
7. The side-by-side normal-pool sandwich.


## Fee and schedule integration

Deployments pass `Config.commitFee` explicitly. `schedule.start - DRAND_GENESIS` and `schedule.batchLength` are multiples of three, and `0 < settleLength <= batchLength`. Round a local start down to the current drand boundary. Both constraints apply: aligned beacon publication and nonoverlapping settlement windows.

Validate the combined contracts with `cd contracts && forge test --fuzz-runs 4096` and `python3 -m unittest discover -s contracts/test/clearing_model -v` from the repository root. Client/keeper fixtures must use the generated configuration tuple and compatible schedules. Consumers treat `Released` as a terminal commitment status and read `admissionRequired()` to distinguish release from slashing when describing cleanup.
