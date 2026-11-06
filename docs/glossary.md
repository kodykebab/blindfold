# Glossary

| Term | Meaning |
|---|---|
| **Admission** | A deployment mode where each order carries zero-knowledge proofs that it's correctly encrypted and funded. With it on, the settlement is `AdmittedSettlement`. |
| **Batch** | A fixed window (for example 300 s) whose orders settle together at one price. Its deadlines are `commitsClose`, `revealOpens`, `revealCloses` and `settleCloses`. |
| **Bounty** | The share of the deposit (`bountyBps`) paid to whoever reveals an order. Reveal your own order to keep it. |
| **Clearing price** | The single price every filled order in a batch gets. |
| **Cleanup** | The client command that does whatever is possible to unblock withdrawal: reveal your own order, release or slash unrevealed ones, expire unsettled batches. |
| **Commit** | Submitting an encrypted order to the current batch. The vault locks its input and a deposit. |
| **Commit fee** | A small fee kept on every commit. |
| **Court** | The separate system that slashes a bonded "protected RPC" when a transaction it protected is proven sandwiched. Built from `SandwichCourtVerifier` and `BondRegistry`. |
| **Deposit** | Collateral locked with each commit, returned when the order is revealed (minus the bounty, if someone else revealed it). |
| **drand** | A public randomness beacon (the quicknet chain, one round every 3 s). Orders are encrypted to a future round. |
| **Expire** | Closing a batch nobody settled by `settleCloses`. Anyone can do it, and it unlocks the input. |
| **Keeper** | A permissionless service that reveals orders once their round is out and closes what nobody revealed. |
| **Padding** | A zero-size order that hides how many real orders an account placed. |
| **Partial fill** | Only part of the input executed; the unused part stays in your vault. |
| **Preparation** | The slow admission proof built ahead of time for a chosen batch, so an order then only needs the fast online proof. A submission uses it up. |
| **Private state** | Your saved orders, salts and funding state on your machine. You need it to reveal your own orders; back it up. |
| **Release** | Closing an unrevealed order with admission on: the deposit is returned minus the fee. |
| **Reveal** | Publishing a decrypted order and its salt so the contract can check it against the commitment. |
| **Salt** | Random bytes mixed into the commitment hash, so an order can't be guessed from its hash. |
| **Sandwich** | Buying just before a victim's swap and selling just after it, profiting from the price movement it causes. |
| **SealedPoolHook** | The Uniswap v4 hook that lets only the settlement contract swap in the pool. |
| **Slash** | Closing an unrevealed order with admission off: the deposit is forfeited. |
| **Solver** | A permissionless service that proposes the clearing price and settles each batch. The contract verifies it. |
| **Timelock encryption** | Encryption that can only be decrypted once a specific drand round is published (tlock). |
| **Vault** | The contract that holds your balances. Withdrawals are blocked while any of your commitments is open. |
| **Witness** | The private inputs to an admission proof (order, funding, keys). They never leave your machine. |
