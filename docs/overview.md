# Overview

## The problem

When you swap on a public chain, your transaction sits in a public queue before it's included. A searcher who sees it can **sandwich** it: buy just before you (pushing the price up), let your trade fill at the worse price, then sell just after. You pay the difference. "Protected RPCs" promise to hide your transaction, but nothing holds them to it.

## Blindfold: nothing to front-run

Blindfold removes the information a sandwich needs, and the ordering it relies on.

1. **Sealed orders.** Your order (side, amount, limit price) is encrypted with **timelock encryption** to a future round of the public **drand** beacon. Nobody can read it, including the operators, until that round is published, which happens after the batch closes.
2. **Batches.** Orders are collected in fixed windows (for example, 300 seconds). There's no "before you" or "after you" inside a batch.
3. **Anyone can reveal.** Once the beacon round is out, anyone can decrypt and reveal the batch's orders. A **keeper** does this for a bounty, or you can reveal your own order and keep the bounty.
4. **One price for everyone.** A **solver** proposes a single clearing price. The contract checks it, matches buyers against sellers, and routes only the leftover through a Uniswap v4 pool. That pool's hook lets **only the settlement contract** swap in it.
5. **You keep control of your funds.** Funds sit in a vault under your account. You can withdraw any time no open order is using them.

With **admission** turned on, every order also carries a zero-knowledge proof (Groth16, generated on your machine) that it's correctly encrypted and fully funded. Garbage or unfunded orders can't be used to grief a batch.

## Court: making "protected" RPCs accountable

A protected RPC posts a **bond** in `BondRegistry` and signs a receipt for each transaction it accepts. If that transaction is later sandwiched on chain, anyone can prove it entirely on chain, from block header, transaction and receipt proofs, using `SandwichCourtVerifier`. The victim is then paid from the RPC's bond. See [`DEMO.md`](../DEMO.md) for the end-to-end demo.

## What's in the repository

| Part | What it is | Where |
|---|---|---|
| Contracts | Vault, batch auction, settlement, the v4 hook, admission verifiers, external market reference, Court | [`contracts/src`](../contracts/src) |
| Client (CLI) | Your local tool: deposit, encrypt and commit, track, clean up, withdraw, back up. **It holds the key and signs.** | [`packages/client`](../packages/client) |
| Local prover | Builds the admission proofs on your machine (Go, gnark) | [`packages/proof-bench/circuit`](../packages/proof-bench/circuit) |
| Keeper | Reveals orders once their beacon round is out; slashes or releases what nobody revealed; expires unsettled batches | [`packages/keeper`](../packages/keeper) |
| Solver | Finds the clearing price and settles each batch | [`packages/solver`](../packages/solver) |
| Trading page | A local web page that drives the CLI. It never holds keys. | [`app/haveibeensandwiched`](../app/haveibeensandwiched) |
| Arkiv mirror | A public, queryable history of settled batches (optional) | [`packages/arkiv`](../packages/arkiv) |
| Chrome extension | Wallet-signed trading: the extension, its native prover helper, and a bridge page for MetaMask and other wallets | [`packages/extension`](../packages/extension), [`prover-helper`](../packages/prover-helper), [`bridge`](../packages/bridge) |
| Court watcher | Finds sandwiches and builds claim proofs | [`packages/court-watcher`](../packages/court-watcher) |
| Scripts | Local stack, test tiers, demos | [`scripts`](../scripts) |

## Current status

Everything runs locally against Anvil with test tokens. The release checklist is [`CHECKLIST.md`](../CHECKLIST.md). Notable open items:
- production proving parameters (today's parameters come from a single-machine setup, development only);
- encrypting local private state at rest;
- enabling CI on GitHub.
