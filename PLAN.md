# PLAN.md

Feature checklist, three phases, and who builds what. Design: [CONTEXT.md](CONTEXT.md). Status: [HANDOFF.md](HANDOFF.md). How we work: [CONTRIBUTING.md](CONTRIBUTING.md).

Tick your own boxes as you merge. ⚑ = a teammate consumes this in the next phase, so do it first.

## Team and lanes
Each lane is a vertical slice with its own local check, and each prize has one owner.

| Who | Lane | Prize | Owns (edit freely) |
|---|---|---|---|
| **Kritarth** | Blindfold onchain: contracts, deploy, Aqua, solver | Uniswap (hook + settlement), 1inch | `contracts/src/{BatchAuction,BlindfoldVault,BlindfoldSettlement,SealedPoolHook}.sol`, `contracts/src/swapvm/`, `contracts/script/DeployBlindfold.s.sol` (+ other Blindfold scripts), `contracts/test/Blindfold*.t.sol`, `contracts/test/swapvm/`, `packages/solver/`, `FEEDBACK.md` |
| **Bhoumik** | Court: bonds, watcher service, demo bots | Uniswap (Court) | `contracts/src/court/` (Kritarth reviews changes to `SandwichCourtVerifier.sol`), `contracts/script/DeployCourt.s.sol`, `contracts/test/court/`, `packages/court-watcher/`, `packages/demo-bots/`, `DEMO.md` |
| **Khush** | Client, keeper, Arkiv, UI | Arkiv (+ Swarm bonus) | `packages/{arkiv,client,keeper}/`, `app/`, `arkiv/` |

Shared (small PR, tell the others): `foundry.toml`, `.gitmodules`, `.gitignore`, `env.sh`, `README.md`, `AGENTS.md`, `CONTEXT.md`, `HANDOFF.md`, `PLAN.md`, `CONTRIBUTING.md`, `contracts/test/utils/`.

## How nobody gets blocked
1. **Build against seams, not branches.** The seams below are fixed now. Nobody waits on a teammate's unfinished branch.
2. **A phase only uses what's on `main` from an earlier phase, or a fake you own.** Every lane has an offline mode (fixtures, `ARKIV=off`, seed data), so anyone can run their piece alone.
3. **Producers ship ⚑ items first**, so they're on `main` well before the next phase needs them.
4. **Phase end = 15-minute sync.** Everyone merges, runs the phase's exit check, ticks boxes, and re-splits leftovers.

## Seams
Change a seam additively (new key, new event, new optional attribute). A breaking change needs the consumers' OK and an update to this table in the same PR.

| Seam | Producer | Consumers | Shape |
|---|---|---|---|
| Contract ABIs and events | Kritarth, Bhoumik | everyone | As listed in [HANDOFF.md](HANDOFF.md#interfaces-to-build-against). Read ABIs from `contracts/out/` after `forge build`; never hand-copy |
| `deployments/blindfold.local.json` | Kritarth | Khush, Bhoumik, solver | `{chainId, deployBlock, vault, settlement, hook, poolManager, token0, token1, aquaRouter}` (`aquaRouter` from Phase 2) |
| `deployments/court.local.json` | Bhoumik | Khush, watcher | `{chainId, deployBlock, verifier, bondRegistry}` |
| Arkiv entities | Khush (`arkiv/schema.md`) | solver writes `blindfold.batch`, watcher writes `court.*`, UI reads all | The table in [CONTEXT.md](CONTEXT.md#arkiv-entities); attribute names exactly as written there |
| `packages/arkiv` | Khush | solver, watcher, client, keeper, UI | `put(type, attrs, {expiresIn})`, `query(type, where)`. `ARKIV=off` stores to `.arkiv-local/<type>.jsonl` (gitignored) |
| Local chain | — | everyone | anvil fork of Unichain on `:8545`, `--accounts 20` |
| Anvil accounts | — | everyone | 0 deployer · 1 keeper · 2 solver · 3 watcher · 4 leaky-RPC signer · 5 sandwich bot · 10–19 users. Separate accounts so bots never collide on nonces |
| Ports | — | everyone | anvil `8545` · leaky RPC `8546` · app `3000` |
| Package scripts | each owner | everyone | every package has `npm start` (its service or CLI) and `npm test` (`node --test`) |

## Local dev chain
Everyone runs the same thing. The deploy scripts don't exist yet; they're the first ⚑ items below.
```bash
source env.sh
anvil --fork-url https://mainnet.unichain.org --accounts 20 --port 8545
```
```bash
cd contracts
forge script script/DeployBlindfold.s.sol --rpc-url http://127.0.0.1:8545 --broadcast   # Kritarth, Phase 1
forge script script/DeployCourt.s.sol --rpc-url http://127.0.0.1:8545 --broadcast       # Bhoumik, Phase 1
```

## Already done
Vault, commit, anyone-reveal, slashing, padding orders, verified settle on the sealed v4 pool (local + Unichain fork), `SealedClearing` + router, Court verifier on live mainnet sandwiches, sandwich finder and proof builder. `forge test`: 48/48.

---

## Phase 1: Standalone (≈ h0–12)
Each lane's piece works alone, against fixtures and fakes.

### Kritarth
- [ ] ⚑ `DeployBlindfold.s.sol`: port `BlindfoldTest.setUp` (vault, settlement, mined hook, pool init, LP seed); mint test tokens to users 10–19; take the schedule `start` from the chain's timestamp; write `deployments/blindfold.local.json`.
  Check: fresh fork → script → `cast call <settlement> "currentBatch()(uint64)"` returns, and `cast block latest -f timestamp` is within seconds of `date +%s` (the keeper needs chain time to match drand's clock).
- [ ] Seed script: one batch with plaintext commits + reveals from users 10–19, then time-travel into its settle window (`cast rpc evm_increaseTime`). This is the solver's fixture and gives Khush real chain data. No tlock needed.
- [ ] Aqua strategy: ship script + fork test where `BlindfoldAquaRouter` fills at `activeClearingPriceX96` with real token transfers (taker = settlement).
  Check: `forge test --match-path 'test/swapvm/*'` and the new fork test.
- [ ] `packages/solver`: port `_solve` from `test/Blindfold.t.sol` (search `p*` down from `poolPriceX96()`; `eth_call` `settle` until it succeeds; then send it).
  Check: seed script → `npm start` → a `Settled` event.

### Bhoumik
- [ ] ⚑ `BondRegistry.sol` + tests: `bond`, delayed `unbond`; EIP-712 `Protected{txHash, chainId, acceptedAt, maxBlock}` signed by the RPC; `claim(claim, receipt, sig)` → `verifier.verify` → require `verdict.victimTxHash == receipt.txHash`, block ≤ `maxBlock`, not paid before → pay the victim `max(profit, minPenalty) + prover gas` from the bond.
  Decide first: `profit` comes in pool-token units, so pick the bond's asset and how profit converts to it. Write the decision in CONTEXT.md "Court design".
  Check (offline): `forge test --match-path 'test/court/*'`, with a test RPC key signing a receipt for the victim tx in the existing `v3.json` / `v4.json` fixtures.
- [ ] ⚑ `DeployCourt.s.sol`: verifier (`l1Block = address(0)` locally) + `BondRegistry`, RPC bonded from account 4; write `deployments/court.local.json`.
  Check: fresh fork → script → `cast call <bondRegistry> ...` shows the bond.
- [ ] court-watcher: make the chain and v4 PoolManager configurable (`ETH_RPC`, `V4_POOL_MANAGER`; today `lib.mjs` hardcodes Ethereum mainnet's) so it can find sandwiches on the local Unichain fork.
  Check: `N=300 node find.mjs` still finds mainnet sandwiches with the defaults.

### Khush
- [ ] ⚑ `packages/arkiv` + `arkiv/schema.md`: thin wrapper over `@arkiv-network/sdk` with the `ARKIV=off` file backend; schema copied from CONTEXT.md and frozen.
  Check: `npm test` (put → query round trip with `ARKIV=off`).
- [ ] `packages/client` tlock: encrypt `abi.encode(order, salt)` to a drand quicknet round with `tlock-js`; decrypt once the round is out.
  Check: `npm test` round trip against live drand (no chain needed).
- [ ] `app/` shell (Next.js): batch view, mempool view, Court ledger, all reading `packages/arkiv` with seed rows that match the schema.
  Check: `ARKIV=off npm run dev` shows all three views with seed data.
- [ ] Arkiv access key + faucet tGLM for a team wallet; ask about a Swarm postage batch.

### Phase 1 exit check
`forge test` green on `main`; each person shows their checks above passing on `main`; both deployments files come out of a fresh fork.

---

## Phase 2: Wired (≈ h12–24)
Swap fakes for the real pieces, all on one local fork.

### Kritarth
- [ ] Aqua leg in `settle`: split the residual between the sealed v4 pool and the Aqua strategy, keeping the post-swap marginal-price check. Tests on the local PoolManager and the fork.
- [ ] `DeployBlindfold.s.sol` ships and funds the Aqua strategy; add `aquaRouter` to the deployments file.
- [ ] Solver as a service: settles every batch as its settle window opens; writes `blindfold.batch` through `packages/arkiv`.
- [ ] Malicious-solver script: a bad `p*` reverts (demo step 4).

### Bhoumik
- [ ] `packages/demo-bots`: leaky "protected" RPC on `:8546` (signs a `Protected` receipt, then leaks the tx) and a sandwich bot on a normal (no-hook) v4 pool it deploys for `token0`/`token1` from `blindfold.local.json`.
- [ ] Watcher service (`npm start` in `packages/court-watcher`): new block → sandwich of a receipted tx → build the claim (BLOCKHASH path on the fork, AGENTS.md gotcha 5) → `BondRegistry.claim`; write `court.verdict` and `court.rpc` through `packages/arkiv`.
- [ ] One command for demo step 5: leak → sandwich → claim → refund.

### Khush
- [ ] Client commit flow on the fork: vault deposit, `orderHash`, encrypt, `commit`; write `blindfold.commitment`. Plus `commit-many`: users 10–19 commit to one batch, plus one garbage commitment (demo step 2).
- [ ] `packages/keeper`: Arkiv query for open commitments in closed batches (fallback: `Committed` events) → drand signature → decrypt → `reveal`; `slashUnrevealed` once the window closes.
- [ ] Real Arkiv testnet backend; the UI reads live entities.
- [ ] (Could) Swarm: ciphertext to Swarm, `ctRef` in the commitment.

### Phase 2 exit check: integration target
On one fresh fork with both deploy scripts run: `commit-many` → keeper reveals and slashes the garbage → solver settles (residual through v4 and Aqua) → leak → sandwich → watcher claims → victim refunded. The UI shows the batch, the slash and the verdict from Arkiv testnet.

---

## Phase 3: Demo and submission (≈ h24–36, feature freeze at h30)

### Kritarth
- [ ] `FEEDBACK.md` and the Uniswap developer feedback form.
- [ ] README: exact contract and line pointers for the Uniswap parts (hook, settlement) and the 1inch parts (`SealedClearing`, router, strategy).
- [ ] Rehearse demo step 4 with real token transfers through Aqua.
- [ ] 1inch booth question (see HANDOFF.md).

### Bhoumik
- [ ] `DEMO.md`: the exact commands and terminal layout for demo steps 1–6.
- [ ] (Should) Court on Base: deploy, live `checkpoint()`, one anchored claim on a fresh mainnet sandwich (build the proof within ~25 min, AGENTS.md gotcha 6). Fallback: Base fork.
- [ ] README: Court line pointers. Rehearse demo steps 1 and 5.
- [ ] Uniswap booth question.

### Khush
- [ ] UI polish for demo steps 1–3 and 6.
- [ ] `arkiv/{schema,friction,reach,why-arkiv,how-you-use-arkiv}.md`; wallet addresses and a runnable query in the README.
- [ ] Arkiv booth question.

### Everyone
- [ ] Two clean end-to-end rehearsals from `DEMO.md`.
- [ ] Video (4 min, CONTEXT.md demo script); each records their own steps.
- [ ] Submission form; check every prize's hard requirements in CONTEXT.md once more.

## If we fall behind
Cut in this order, and keep every Must: Swarm → Court on live Base (stay on the fork) → Aqua leg inside `settle` (keep the standalone Aqua fill, which 1inch requires) → side-by-side normal-pool sandwich.
