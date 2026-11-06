# AGENTS.md

Rules for coding agents and humans working in this repo. Three people work in parallel: **Bhoumik, Kritarth, Khush**. Before you edit anything, find out whose lane you're in ([PLAN.md](PLAN.md#team-and-lanes)).

| Read | For |
|---|---|
| [CONTEXT.md](CONTEXT.md) | Product, pitch, prizes, demo script |
| [ARCHITECTURE.MD](ARCHITECTURE.MD) | How the system works, layer by layer, including the admission-proof design |
| [PLAN.md](PLAN.md) | Lanes, seams, the three phases, who builds what |
| [REVIEW.md](REVIEW.md) | Known design flaws R1–R9, with fixes and owners |
| [HANDOFF.md](HANDOFF.md) | Built/not-built status, interfaces, Court fixture workflow, booth questions |

## Setup
```bash
source env.sh                                   # ALWAYS first: this machine's shell defines a recursive `node` function
git submodule update --init --recursive
(cd contracts/lib/swap-vm && npm install --ignore-scripts)
(cd packages/court-watcher && npm install)
```
`env.sh` puts Node 22 and Foundry on `PATH`. If your machine has no such `node` function, it's harmless.

**proof-bench** (admission proofs) also needs Rust (stable). For guest execution and proving, add the RISC Zero toolchain via `rzup` (`cargo-risczero` 3.0.6, `r0vm` 3.0.6), and Docker for the Groth16 wrap:
```bash
bash packages/proof-bench/prepare.sh            # pins tlock-rs, risc0-ethereum and bls12-381 checkouts and applies the patches
npm ci --prefix packages/proof-bench --ignore-scripts
```

## Test
```bash
cd contracts && forge test                                         # everything: 155 tests
forge test --match-path test/Blindfold.t.sol                       # mechanism, local PoolManager (19)
forge test --match-contract BlindfoldUnichainForkTest              # same suite on Unichain's real PoolManager (fork, 19)
forge test --match-path test/ReservationModel.t.sol --fuzz-runs 4096   # private funding model (re-runs the 19 mechanism tests too)
forge test --match-path 'test/swapvm/*'                            # SealedClearing opcode (4)
forge test --match-path 'test/court/*'                             # Court: verifier (23) + BondRegistry on real sandwiches (23) + unit/fuzz (32) + self-sandwich model on a v4 PoolManager (3) + demo sandwich (2) + 1 invariant suite (3 invariants), offline
```
```bash
cargo test --manifest-path packages/proof-bench/Cargo.toml --locked --release                          # native admission relation
mkdir -p packages/proof-bench/results
cargo run  --manifest-path packages/proof-bench/Cargo.toml --locked --release > packages/proof-bench/results/native.json
node packages/proof-bench/interop.mjs packages/proof-bench/results/native.json                        # independent tlock-js + ABI check
(cd packages/proof-bench/evm && forge test -vv)                                                       # RISC Zero verifier plumbing
```
VM proving, Groth16 wrapping and the admission end-to-end gate: [proof-bench README](packages/proof-bench/README.md).

Every change must keep `forge test` green. Add a test with every feature. Fork tests go in their own contract that overrides the setup, like `BlindfoldUnichainForkTest`. Offline tests never touch the network.

## Rules

### Repo
- **Commit early and often, with descriptive messages.** 1inch and Arkiv judge commit history; 1inch rejects one big last-day commit. Never squash or force-push `main`.
- Use the repository's configured user identity for commits. Do not add agent co-author trailers or assistant attribution. Keep commit subjects and descriptions plain and direct, in the user's style.
- **Don't state facts you haven't verified.** Cite sources for numbers and incidents.
- **Keep known limitations, concerns and open questions out of the repo.** Put them in `.workspace.md` at the repo root (gitignored, local only). The one exception is [REVIEW.md](REVIEW.md), the team's tracked list of design flaws and their owners; whether it stays in the submitted repo is a Phase 3 decision.
- Don't name folders `vendor`.
- Third-party code keeps its license and attribution (see `contracts/src/court/lib/LICENSE-optimism`, and the pinned upstreams and patches in `packages/proof-bench`).

### Team
- **Stay in your lane.** Edit only the files your lane owns ([PLAN.md](PLAN.md#team-and-lanes)). To change another lane's file, ask its owner or open a PR and let them merge it. Shared files get small, separate PRs, announced in the chat.
- **Branch and PR.** Branches are `<you>/<topic>` (for example `kritarth/marginal-fill`, `bhoumik/bond-registry`, `khush/keeper`). Merge your own PR once `forge test` and your lane's check pass, if it touches only your lane. A PR that touches a shared file or a seam needs one teammate's 👍.
- **Merge with "Create a merge commit" or "Rebase and merge", never "Squash and merge".** Pull `main` every couple of hours. Keep branches short-lived (hours, not a day).
- **Seams change additively.** A seam is anything another lane reads: ABIs, events, `deployments/*.local.json` keys, Arkiv attributes, the prover CLI's JSON, env vars, ports, anvil account roles. Add new keys, events, overloads or optional attributes. A breaking change needs the consumers' OK and an update to [PLAN.md "Seams"](PLAN.md#seams) in the same PR.
- **Never hardcode deployed addresses or hand-copy ABIs.** Read `deployments/*.local.json` and `contracts/out/` (run `forge build` first).
- **Work async ([PLAN.md "Working async"](PLAN.md#working-async-six-rules-that-keep-anyone-from-blocking)).**
  - Code against the frozen seams, never a teammate's branch.
  - If you consume a seam that doesn't exist yet, write your own fake of it in your package.
  - Start an item as soon as its `Needs:` are on `main`.
  - Merge small and often, with unfinished work behind flags (`ADMISSION`, `ARKIV`, deploy env vars), so `main` always runs.
- **Everything runs alone, locally.** Each piece works in local mode (plain anvil, no keys, `ARKIV=off`, fixtures, recorded drand rounds). If a teammate can't run your piece without you, that's a bug. Before merging, run `scripts/check.sh` once it exists.
- **`PLAN.md`:** tick only your own boxes. **`REVIEW.md`:** update the status of your own R-items when you fix them.
- Don't run `forge fmt` on the whole tree: it reformats other lanes' files. Format only the files you touched.
- Stuck for more than 30 minutes? Say so in the chat. Someone pairs with you, or we fake the piece and move on. At each phase end, run the 15-minute sync in PLAN.md.

### Solidity
- Follow "Compiler setup" below: no `transient` keyword; files that import swap-vm go under `swapvm/` dirs.
- Match the existing style: custom errors, an event for anything a keeper, indexer or UI needs, `@notice` NatSpec on external functions.

### JavaScript
- Follow `packages/court-watcher`: ESM `.mjs`, `viem`, exact versions in `package.json`, one `package.json` per package, `package-lock.json` committed.
- Every package has `npm start` (its service or CLI) and `npm test` (`node --test`, built in, offline). Services also accept `npm start -- --once`: do all the work that is due now, then exit 0, so `scripts/e2e.sh` can step through a run. Test the logic that can break (price search, encoding, decrypt, claim building), not the plumbing.
- Configure through env vars with local defaults, for example `RPC_URL` defaulting to `http://127.0.0.1:8545`. Document new vars in PLAN.md "Seams".
- `app/` can be Next.js + TypeScript. It reads from `packages/arkiv` and the deployments files, not from other packages' internals.

### Rust (proof-bench)
- Always build with `--locked`. Upstream revisions are pinned in `prepare.sh`, and patches stay minimal, with upstream licenses kept.
- Generated receipts and measurements go under the ignored `results/` directory. Record toolchain versions and the program identity with every benchmark result.
- Measure guest execution, proof generation, wrapping and onchain verification separately. Only a completed end-to-end run counts as an end-to-end latency sample.
- The `accelerated` feature changes the guest's program identity. Keep each variant's host binary with its own receipts.

### Keys and secrets
- Locally, use anvil's default accounts in the roles PLAN.md assigns. They're public test keys: fine on anvil, never on a real chain.
- Real keys (the Arkiv wallet, a Base deployer) go in `.env` (gitignored). Never in code, commits, PR text or chat.

### Working with coding agents
- Tell your agent your name and lane, and paste the PLAN.md item you're on.
- The agent must not edit outside your lane or change a seam without you.
- Read the diff and run the checks before you commit. Don't commit code you haven't run.

## Layout
```
contracts/            Foundry
  src/BlindfoldVault.sol  BatchAuction.sol  BlindfoldSettlement.sol  SealedPoolHook.sol
  src/swapvm/         SealedClearing.sol (SwapVM instruction), BlindfoldAquaRouter.sol
  src/court/          SandwichCourtVerifier.sol, BondRegistry.sol, lib/ (Optimism RLPReader, MerkleTrie, Bytes)
  test/               Blindfold.t.sol, BlindfoldUnichainFork.t.sol, ReservationModel.t.sol, swapvm/, court/ (+ fixtures/), utils/
  lib/                forge-std v1.11.0, v4-core v4.0.0, swap-vm v1.0.2 (submodules, pinned)
packages/court-watcher/  find.mjs (scan), prove.mjs (claim + anchor fixtures), signed.mjs, lib.mjs
packages/proof-bench/    admission-proof prototype: Rust checker (src/), RISC Zero guests + hosts (vm/; `prepared` splits key preparation from the online proof), verifier tests (evm/), interop scripts
```
Planned, with owners in [PLAN.md](PLAN.md#team-and-lanes): `contracts/script/` (`DeployBlindfold`, `SeedBatch`, `DeployCourt`), `contracts/src/admission/`, `deployments/` (local addresses, gitignored), `packages/{arkiv,client,keeper,solver,demo-bots}`, `scripts/` (`check.sh`, `e2e.sh`), `app/` (Next.js), `arkiv/*.md`, `FEEDBACK.md`, `DEMO.md`.

## Compiler setup (don't break it)
- v4-core's `PoolManager` pins `solc =0.8.26`. Our contracts use `pragma ^0.8.24` so they compile alongside it: **don't use the `transient` keyword** (needs 0.8.28); use assembly `tstore`/`tload`.
- swap-vm is `0.8.30` and needs via-IR. `foundry.toml` turns on via-IR only for `lib/swap-vm/**`, `src/swapvm/**`, `test/swapvm/**` via `compilation_restrictions`. Files importing swap-vm go under `swapvm/` dirs.
- OpenZeppelin is remapped to swap-vm's copy; v4-core keeps its own through a context remapping.
- Foundry `rpc_endpoints` doesn't support `${VAR:-default}`; use plain URLs.
- The proof-bench Solidity verifier tests live in their own Foundry project (`packages/proof-bench/evm`), separate from `contracts/`.

## Technical gotchas
1. **Uniswap v4 `Swap` amounts are swapper-side** (negative = paid in), the opposite of v3's pool-side amounts, despite `IPoolManager`'s NatSpec. Court negates v4 amounts.
2. **Optimism's `RLPReader.readList` caps lists at 32 items**; real receipts have more logs. Our copy grows the array on overflow (marked in the file). Don't replace it with upstream.
3. **v4 hook addresses encode permissions.** `SealedPoolHook` must be CREATE2-deployed at an address whose low bits are exactly its hook flags (today `BEFORE_SWAP_FLAG`; `test/utils/HookDeployer.sol` mines the salt). Deploy the settlement first, mine the hook against its address, then call `settlement.initialize(poolKey)`. Adding hook permissions (REVIEW R5) means re-mining.
4. **`AquaSwapVMRouter._instructions()` isn't virtual**, so `BlindfoldAquaRouter` re-composes `SwapVM + AquaOpcodes` and appends `SealedClearing` (opcode index = `AquaOpcodes` length; read it from `sealedClearingOpcode()`).
5. **On an anvil fork, EIP-2935 returns wrong hashes for blocks anvil mines locally**; `BLOCKHASH` is right. Court on a local fork uses the BLOCKHASH path.
6. **Public RPCs prune state after ~128 blocks.** Build anchor proofs (`eth_getProof`) right after choosing the anchor. Anchors must be L1 blocks Base's `L1Block` has actually reported (`prove.mjs` reads it from Base).
7. **The L1 anchor window is 8,191 blocks** (~27 h): the target sandwich must be within it.
8. Prices are `token1 per token0 × 2^96` (= `sqrtPriceX96² / 2^96`). `activeClearingPriceX96(t1, t0)` returns the inverse.
9. drand quicknet: genesis `1692803367`, period 3 s, chain hash `52db9ba7…c84e971`. Batch `b` targets round `roundAt(commitsClose(b)) + 2`, which is 4–6 s after commits close; it's 6 s only when `start − genesis` and `batchLength` are multiples of 3 (REVIEW R7).
10. **`ReservationModelTest` inherits `BlindfoldTest`**, so it re-runs the 19 mechanism tests, and the total counts them twice.
11. **Admission proofs are a prototype.** `commit()` still accepts any ciphertext; `ReservationModel.t.sol` uses plaintext witnesses. Don't treat either as enforced until the admission entry point lands (REVIEW R2).
12. **Don't time-travel a chain the keeper uses.** drand runs on wall-clock time, so `evm_increaseTime` puts chain time ahead of the round and reveals break. Run time-travel fixtures (`SeedBatch.s.sol`) on their own fresh anvil.

## RPCs
- Ethereum: `https://ethereum-rpc.publicnode.com` (`ETH_RPC` to override); supports `eth_getBlockReceipts`, raw tx by index, `eth_getProof` for recent blocks.
- Base: `https://mainnet.base.org` (`BASE_RPC`). Unichain: `https://mainnet.unichain.org`.
- Unichain addresses: v4 PoolManager `0x1F98400000000000000000000000000000000004`. Ethereum v4 PoolManager `0x000000000004444c5dc75cb358380d2e3de08a90`. EIP-2935 `0x0000F90827F1C53a10cb7A02335B175320002935`. Base `L1Block` `0x4200000000000000000000000000000000000015`.
