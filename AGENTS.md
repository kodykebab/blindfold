# AGENTS.md

Instructions for coding agents (and humans) working in this repo. Read [CONTEXT.md](CONTEXT.md) for the product and design, and [HANDOFF.md](HANDOFF.md) for current status and what to build next.

## Setup
```bash
source env.sh                                   # ALWAYS first: this machine's shell defines a recursive `node` function
git submodule update --init --recursive
(cd contracts/lib/swap-vm && npm install --ignore-scripts)
(cd packages/court-watcher && npm install)
```
`env.sh` puts Node 22 and Foundry on `PATH`. If your machine has no such `node` function, it's harmless.

## Test
```bash
cd contracts && forge test                                   # everything (48 tests)
forge test --match-path test/Blindfold.t.sol                 # mechanism, local PoolManager
forge test --match-contract BlindfoldUnichainForkTest        # same suite on Unichain's real PoolManager (fork)
forge test --match-path 'test/swapvm/*'                      # SealedClearing opcode (swap-vm test helpers)
forge test --match-path 'test/court/*'                       # Court, offline, real mainnet sandwiches
```
Every change must keep `forge test` green. Add a test with every feature.

## Rules
- **Commit early and often, with descriptive messages.** 1inch and Arkiv judge commit history; 1inch rejects one big last-day commit. Never squash or force-push `main`.
- End commit messages with a `Co-Authored-By:` line when an agent wrote the change.
- **Don't state facts you haven't verified.** Cite sources for numbers and incidents.
- **Keep known limitations, concerns and open questions out of the repo.** Put them in `.workspace.md` at the repo root (gitignored, local only).
- Don't name folders `vendor`.
- Third-party code keeps its license and attribution (see `contracts/src/court/lib/LICENSE-optimism`).

## Layout
```
contracts/            Foundry
  src/BlindfoldVault.sol  BatchAuction.sol  BlindfoldSettlement.sol  SealedPoolHook.sol
  src/swapvm/         SealedClearing.sol (SwapVM instruction), BlindfoldAquaRouter.sol
  src/court/          SandwichCourtVerifier.sol, lib/ (Optimism RLPReader, MerkleTrie, Bytes)
  test/               Blindfold.t.sol, BlindfoldUnichainForkTest, swapvm/, court/ (+ fixtures/)
  lib/                forge-std v1.11.0, v4-core v4.0.0, swap-vm v1.0.2 (submodules, pinned)
packages/court-watcher/  find.mjs (scan), prove.mjs (claim + anchor fixtures), signed.mjs, lib.mjs
```
Planned: `packages/{client,keeper,solver,demo-bots}`, `app/` (Next.js), `arkiv/*.md`, `FEEDBACK.md`.

## Compiler setup (don't break it)
- v4-core's `PoolManager` pins `solc =0.8.26`. Our contracts use `pragma ^0.8.24` so they compile alongside it: **don't use the `transient` keyword** (needs 0.8.28); use assembly `tstore`/`tload`.
- swap-vm is `0.8.30` and needs via-IR. `foundry.toml` turns on via-IR only for `lib/swap-vm/**`, `src/swapvm/**`, `test/swapvm/**` via `compilation_restrictions`. Files importing swap-vm go under `swapvm/` dirs.
- OpenZeppelin is remapped to swap-vm's copy; v4-core keeps its own through a context remapping.
- Foundry `rpc_endpoints` doesn't support `${VAR:-default}`; use plain URLs.

## Technical gotchas
1. **Uniswap v4 `Swap` amounts are swapper-side** (negative = paid in), the opposite of v3's pool-side amounts, despite `IPoolManager`'s NatSpec. Court negates v4 amounts.
2. **Optimism's `RLPReader.readList` caps lists at 32 items**; real receipts have more logs. Our copy grows the array on overflow (marked in the file). Don't replace it with upstream.
3. **v4 hook addresses encode permissions.** `SealedPoolHook` must be CREATE2-deployed at an address whose low bits are exactly `BEFORE_SWAP_FLAG` (`test/utils/HookDeployer.sol` mines the salt). Deploy the settlement first, mine the hook against its address, then call `settlement.initialize(poolKey)`.
4. **`AquaSwapVMRouter._instructions()` isn't virtual**, so `BlindfoldAquaRouter` re-composes `SwapVM + AquaOpcodes` and appends `SealedClearing` (opcode index = `AquaOpcodes` length; read it from `sealedClearingOpcode()`).
5. **On an anvil fork, EIP-2935 returns wrong hashes for blocks anvil mines locally**; `BLOCKHASH` is right. Court on a local fork uses the BLOCKHASH path.
6. **Public RPCs prune state after ~128 blocks.** Build anchor proofs (`eth_getProof`) right after choosing the anchor. Anchors must be L1 blocks Base's `L1Block` has actually reported (`prove.mjs` reads it from Base).
7. **The L1 anchor window is 8,191 blocks** (~27 h): the target sandwich must be within it.
8. Prices are `token1 per token0 × 2^96` (= `sqrtPriceX96² / 2^96`). `activeClearingPriceX96(t1, t0)` returns the inverse.
9. drand quicknet: genesis `1692803367`, period 3 s, chain hash `52db9ba7…c84e971`. Batch `b` targets round `roundAt(commitsClose(b)) + 2`.

## RPCs
- Ethereum: `https://ethereum-rpc.publicnode.com` (`ETH_RPC` to override); supports `eth_getBlockReceipts`, raw tx by index, `eth_getProof` for recent blocks.
- Base: `https://mainnet.base.org` (`BASE_RPC`). Unichain: `https://mainnet.unichain.org`.
- Unichain addresses: v4 PoolManager `0x1F98400000000000000000000000000000000004`. Ethereum v4 PoolManager `0x000000000004444c5dc75cb358380d2e3de08a90`. EIP-2935 `0x0000F90827F1C53a10cb7A02335B175320002935`. Base `L1Block` `0x4200000000000000000000000000000000000015`.
