# CONTEXT.md

What we're building and why it's designed this way. Status and next steps: [HANDOFF.md](HANDOFF.md). How to work in the repo: [AGENTS.md](AGENTS.md).

## The event
ETHGlobal Mumbai. Team of 4, 36 hours, up to 3 partner prizes.

## One-liner
*MEV protection without a middleman to trust: prevented by construction, punished by proof.*

## Pitch (30 s)
- Every "MEV-protected" swap today relies on a middleman: a private RPC, a builder's promise, a keyper committee, a sequencer network, or a solver. Protected transactions still get sandwiched: 2,932 private sandwiches in Nov–Dec 2024 ([arXiv 2512.17602](https://arxiv.org/html/2512.17602)).
- **Blindfold** batches orders encrypted to a *future* drand round. Nobody, including the user, can read an order before the batch closes, and *anyone* can reveal it after. That kills front-running and the commit-reveal "free option" (a user withholding an unfavourable reveal).
- Batches clear at **one price the contract verifies**, against a Uniswap v4 pool only batches can touch, plus 1inch Aqua liquidity through a custom SwapVM instruction. It's the FM-AMM design ([Canidio & Fritsch](https://arxiv.org/abs/2307.02074)), so arbitrage value goes to LPs.
- **Court** turns a protected RPC's promise into a slashable contract: when a tx it signed a protection receipt for gets sandwiched, anyone proves it onchain (header, tx and receipt proofs, attacker's signature recovered) and the RPC's bond pays the victim. It runs on Base and judges Ethereum through an L1 anchor.

## Prize picks
| Prize | What we show | Hard requirements |
|---|---|---|
| **Uniswap Foundation**, Build with Uniswap, $10k (4k/3k/2k/1k) | `SealedPoolHook` + batch settlement on v4; Court's v3/v4 sandwich predicate | Public repo, `FEEDBACK.md`, Uniswap developer feedback form, README pointing to exact contracts and lines |
| **1inch**, Build an Aqua App, $5k (2.5k/1.5k/1k) | Custom SwapVM instruction `SealedClearing` + Aqua-shipped strategy filling residuals at the clearing price | Official Aqua/SwapVM (modified router redeploy allowed); onchain token transfers in the demo (local forks OK); steady commit history |
| **Arkiv**, Build on Arkiv (from scratch), $4k (3k/1k) + **Swarm bonus $500** | Expiring commitment index for keeper discovery, batch results, Court's public verdict ledger | Writes to Arkiv testnet with `@arkiv-network/sdk`; a user-visible feature reads from Arkiv; wallet addresses + a runnable query in the README; `/arkiv/schema.md`, `friction.md`, `reach.md`, `why-arkiv.md`, `how-you-use-arkiv.md` |

## Architecture
```
 user (browser) ── tlock-js: encrypt (order, salt) to drand round R_b
   │
   ▼
 BlindfoldVault ◄──── BlindfoldSettlement (is BatchAuction) ────► SealedPoolHook pool (Uniswap v4)
 internal balances     commit(b, hash, ciphertext) + deposit        only the settlement can swap
                       reveal(id, order, salt)  ← anyone, bounty
                       slashUnrevealed(id)
                       settle(b, p*)  ← anyone; contract verifies  ───► Aqua strategy via SealedClearing
                       expire(b)                                        (taker must be the settlement)
 keeper:  Arkiv query → closed batches → drand signature → decrypt → reveal
 solver:  compute p* offchain → settle

 Court (Base): SandwichCourtVerifier.verify(claim) → BondRegistry slashes the RPC that signed the receipt
 court-watcher: find sandwiches → build proofs (+ L1 anchor) → submit → write verdict to Arkiv
```
Demo chain: an anvil fork of **Unichain mainnet** (has Uniswap v4, Aqua and the SwapVM router). Arkiv runs on its testnet (chain ID 7794095); Swarm through a Bee node or gateway.

## Blindfold design
**Timing (drand quicknet, 3 s rounds).** Batch `b` accepts commits until `commitsClose(b)`; orders are encrypted to `targetRound(b) = roundAt(commitsClose) + 2`, so nobody can decrypt while commits are open. The margin is exactly 6 s, because the constructor requires `start` and `batchLength` on 3 s drand round boundaries. The contract only sees block timestamps: if the sequencer's timestamps lag real time by 6 s or more, a commit can land after the batch's key is public. The sequencer is therefore a trust assumption next to drand, for timestamps, for including commits and for not censoring reveals (REVIEW R7). Reveal window: `[time(R_b), +revealLength)`. Settle window: `[revealCloses, +settleLength)`. After that, `expire` unlocks everything. Default cadence in tests: 30 s batches, 24 s reveal, 60 s settle.

**Commit.** Users pre-fund `BlindfoldVault` (ideally both tokens). `commit(b, hash, ciphertext)` takes a fixed refundable deposit and a non-refundable `commitFee` (both in `depositToken`) from the vault and escrows nothing else, so direction and size stay hidden. Padding pays the fee too, so filling all 64 slots costs 64 × `commitFee` (REVIEW R3/S3). `hash = keccak256(abi.encode(chainid, settlement, b, order, salt))`, `order = {owner, zeroForOne, amountIn, minAmountOut}`; the ciphertext is the tlock (AGE) encryption of `abi.encode(order, salt)`, emitted in the event only. `amountIn = 0` is a padding order.

**Reveal: anyone.** After round R the drand signature is public, so keepers decrypt and call `reveal`. The contract checks the hash, that `order.owner` is the committer, and that the vault covers `amountIn` (then locks it). The revealer gets `bountyBps` of the deposit and the owner gets the rest back. An unfunded order forfeits the deposit; a commitment nobody reveals is slashed with `slashUnrevealed` after the window.

**No free option.** The vault blocks withdrawals while an account has an open commitment, so a committer can't drain the vault after seeing the market to make their order fail.

**Settle: verified, not trusted.** Anyone calls `settle(b, p*)`:
1. each revealed order fills iff its limit holds at `p*` (fills follow from the price; the solver chooses nothing else);
2. the net imbalance is swapped as **one exact-input residual swap** on the sealed pool, and its output must cover what the batch owes;
3. the pool's **marginal price after that swap must equal `p*`** within `toleranceBps` (the FM-AMM condition; tolerance > pool fee). Only the settlement can swap the sealed pool, so nobody can move that price beforehand;
4. every filled order gets the same `p*`; residual output above what's owed is **donated to in-range LPs**.

**SealedClearing (SwapVM).** An Aqua LP ships a strategy whose program runs `SealedClearing(settlement)`: it reverts unless the taker is the settlement and a batch is being settled, and fills exactly at `activeClearingPriceX96` (a transient value set during `settle`). Aqua tracks virtual balances, so the same LP capital can back other strategies too.

## Court design
**Who's accountable:** the protected RPC. It signs an EIP-712 receipt per protected tx, `Protected{txHash, chainId, acceptedAt, maxBlock}`, and bonds in `BondRegistry`. If that tx is sandwiched, the RPC leaked it or built the sandwich.

**`verify(claim)`:**
1. block hash from `BLOCKHASH` (256 blocks), EIP-2935 (8,191 blocks), or the **L1 anchor**: a permissionless `checkpoint()` stores Base's `L1Block` hash; the claim proves that anchor header, then an account + storage proof of L1's EIP-2935 contract yields the target block's hash;
2. front, victim and back txs proven into the tx trie at `j < i < k`; all three signers recovered onchain (legacy, EIP-155, types 1–4);
3. receipts proven into the receipt trie; one Swap log each (index hint) for the claimed v3 pool or v4 pool ID;
4. predicate: front and victim same direction, back opposite and closing the front position (±1%), front signer == back signer ≠ victim signer, attacker net positive.

Returns block, victim tx hash, attacker EOA, victim, profit. **Payout (to build):** `max(attacker profit, minimum penalty) + prover gas`, from the RPC's bond.

**Cost on Base** (priced with Base's `GasPriceOracle`, Nov 2026 gas prices): a v3 claim on an L1 sandwich ≈ 0.00001 ETH; v4 ≈ 0.000015 ETH.

## Arkiv entities
| Entity | Queryable fields | Owner | Expires |
|---|---|---|---|
| `blindfold.commitment` | `batchId`, `status` (open/revealed/slashed), `commitHash`, `ctRef` (Swarm ref) | committer's wallet | reveal deadline + 1 h |
| `blindfold.batch` | `batchId`, `pair`, `clearingPrice`, `fills`, `residualVenue`, `settleTx` | settlement service | 30 days |
| `court.verdict` | `rpcId`, `pool`, `block`, `refund`, `victimTx` | watcher | 1 year |
| `court.rpc` | `rpcId`, `bond`, `provenSandwiches` | watcher | refreshed hourly |

Why Arkiv: keepers anywhere find reveal work with one query and no server of ours; commitments expire exactly when they stop mattering; the verdict ledger is queryable by anyone and owned by the wallet that wrote it. Funds and verdict truth live onchain; Arkiv is the discovery and read layer.

## Demo script (4 min)
1. **0:00 The problem.** Mempool view: a normal swap on a normal pool gets sandwiched by our bot; the loss shows in red.
2. **0:40 Blindfold.** Ten wallets commit to one batch. The mempool shows only ciphertext; the sandwich bot finds nothing.
3. **1:20 Round R arrives.** A third-party keeper (another laptop) decrypts and reveals, including the order of a user who "rage-quits". A garbage commitment is slashed.
4. **2:00 Settle.** One clearing price for everyone; the residual routes through the sealed v4 pool and the Aqua strategy with real token transfers. A malicious solver's bad price reverts.
5. **2:50 Court.** Our "protected" RPC leaks a tx and it gets sandwiched. The watcher proves it; the victim is refunded from the RPC's bond.
6. **3:30 Ledger.** The Arkiv-backed Court ledger updates. Close on the one-liner.

## Scope
- **Must:** commit → anyone-reveal → verified uniform-price settle on the sealed v4 pool; garbage-commit slashing; one Court claim on a real sandwich with an automatic refund; Arkiv-backed ledger and keeper discovery.
- **Should:** Aqua `SealedClearing` residual route in `settle`; side-by-side "normal pool gets sandwiched"; padding orders (done).
- **Could:** onchain drand BLS verification (EIP-2537); full victim-loss calculation; refund hook.
