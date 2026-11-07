# Uniswap developer feedback

From building **Blindfold**, a sealed-bid batch auction on a Uniswap v4 hook, and **Court**, which proves sandwiches from v3 and v4 `Swap` logs. We built against `Uniswap/v4-core` at `e50237c` (Jan 2025) only, without v4-periphery, and also used Uniswap v3 pools as a price reference and on Unichain Sepolia.

## What worked well

- **`beforeSwap` receives the swap's caller.** `sender` is the contract that called `PoolManager.swap`, so "only our settlement contract may swap this pool" is a two-line check ([`SealedPoolHook.sol` L25–34](contracts/src/SealedPoolHook.sol#L25-L34)). That one check is our whole MEV guard.
- **Flash accounting.** One `unlock` per batch, then `swap`, `sync`/`settle` and `take`, made the batch's single residual swap simple and atomic ([`BlindfoldSettlement.sol` L505–548](contracts/src/BlindfoldSettlement.sol#L505-L548)).
- **`donate`.** It gave us a clean way to hand the batch's surplus to in-range LPs instead of keeping it.
- **`StateLibrary.getSlot0`.** Cheap price reads for the post-swap check, with no extra view contract.
- **`WrappedError` (ERC-7751).** A failing hook names itself, its function and its reason, so our test asserts the exact `OnlySettlement` revert.
- **Published deployments.** The Unichain Sepolia PoolManager address and the deployment manifest let our testnet demo find Uniswap's contracts in code instead of hard-coding them.

## Friction, with suggestions

1. **Hook permissions encoded in the address create a deployment loop.**
   - **The loop:** the hook's address depends on its constructor arguments, which include our settlement contract. The settlement needs the pool key, and the pool key includes the hook address.
   - **Our workaround:** deploy the settlement, mine a CREATE2 salt for the hook, then call a one-shot `initialize(key)` on the settlement. We wrote the miner three times: in a Forge script, in the JS dev stack and in tests.
   - **Suggestions:** a small salt-mining helper in v4-core, or docs showing this initialize-later pattern for hooks that reference their own consumer.
2. **There's no minimal production hook base in v4-core.**
   - **What we did:** to implement only `beforeSwap`, our production hook inherits `v4-core/src/test/BaseTestHooks.sol`, a test helper, because `BaseHook` lives in periphery and other packages.
   - **Suggestion:** a tiny base contract in core, or a clear pointer to the one canonical place.
3. **Delta sign conventions are easy to get wrong.**
   - **The convention:** swap deltas are from the swapper's side, so the input is negative and the output positive. Casting them to `uint256` without checking the sign is a silent bug.
   - **What we did:** our own security review flagged it, and we added explicit sign checks before every cast.
   - **Suggestions:** helpers like `amountIn(delta, zeroForOne)` and `amountOut(...)`, or a prominent docs example with the checks in place.
4. **The `sync` → transfer → `settle` order is easy to get wrong.**
   - **The problem:** the docs explain it, but when it's wrong, the revert at the end of `unlock` doesn't say which currency was left unsettled.
   - **Suggestion:** include the currency and amount in that revert.
5. **Wrapped hook reverts are hard to decode off chain.**
   - **The problem:** `WrappedError` nests the hook's reason inside bytes, and common tooling (viem's `ContractFunctionRevertedError`) shows only the outer error. To show "the bot's front-run was rejected by the hook" in our demo, we traced the transaction to find the inner selector.
   - **Suggestion:** a short docs recipe for decoding ERC-7751 in viem and ethers.
6. **The Unichain Sepolia faucet flow has a trap.** On Unichain Sepolia, the first account of the public Anvil and Hardhat test mnemonic is EIP-7702-delegated to a sweeper that drains any ETH it receives. Developers commonly reuse that mnemonic for testnets, so a warning on the testnet and faucet pages would save people funds and time.
7. **v3 oracles on quiet pools.**
   - **The problem:** our v3 reference reads `observe()` and refuses stale observations. Fork tests against the latest block failed whenever the USDC/WETH 0.05% pool hadn't traded within our freshness window.
   - **Suggestion:** guidance on staleness checks, such as using `observe()` with the last observation's timestamp versus pinning fork blocks.

## Overall

v4's hook model fit our design exactly: a pool that only a sealed batch can trade, with everything else (liquidity, pricing, accounting) left to the PoolManager. Most of our time went into deployment ordering (item 1) and getting delta signs and settlement order right (items 3–4). Better defaults or docs there would make hooks like ours much quicker to build safely.
