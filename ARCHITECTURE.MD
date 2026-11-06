# Blindfold architecture

This document describes the executable contracts, the private funding model, and the admission-proof design as separate layers. Source links identify which layer implements each behavior. The product combines an encrypted batch auction with a separate onchain sandwich-evidence verifier called Court.

The intended auction property is that accepted orders are correctly encrypted for a future public beacon round and cumulatively funded before acceptance. The sender knows its own order. Encryption delays disclosure to other participants; it does not prevent a sender from voluntarily disclosing an order.

There are now two versioned auction paths. The pair path below retains its existing order and settlement ABIs. The global path in [§14](#14-global-multi-token-auctions) uses one shared vault operator, explicit token indices, mandatory global admission proofs and atomic cross-pair settlement. Pair proofs and global proofs have different statements and verifier interfaces.

## 1. System map

```mermaid
flowchart TB
    User[User-controlled CLI]
    Prover[Local admission prover]
    Vault[BlindfoldVault]
    Auction[BatchAuction / BlindfoldSettlement]
    Beacon[drand quicknet]
    Keeper[Permissionless revealer]
    Solver[Permissionless price proposer]
    Pool[Uniswap v4 PoolManager]
    Hook[SealedPoolHook]
    Aqua[SealedClearing / Aqua router]
    Index[Arkiv discovery and read layer]
    Court[SandwichCourtVerifier]
    Watcher[Court watcher]
    Bonds[Proposed receipt and compensation layer]

    User -->|deposit tokens| Vault
    User -->|private witness| Prover
    Prover -.->|target admission proof| Auction
    User -->|current commit interface| Auction
    Auction <-->|balances, locks, open count| Vault
    Beacon -->|round signature| Keeper
    Index -.->|discover commitments| Keeper
    Auction -->|ciphertext event| Keeper
    Keeper -->|order and salt| Auction
    Solver -->|proposed price| Auction
    Auction -->|residual swap| Pool
    Pool -->|beforeSwap authorization| Hook
    Auction -.->|target residual integration| Aqua
    Watcher -->|header, transaction and receipt proofs| Court
    Court -.->|authenticated verdict| Bonds
```

Solid arrows show executable interactions or direct offchain inputs. Dashed arrows show target integration boundaries. They are architectural intent, not a deployment diagram.

| Layer | Source | Responsibility |
|---|---|---|
| Custody | [BlindfoldVault.sol](contracts/src/BlindfoldVault.sol) | Internal balances, input locks, withdrawal restriction, operator transfers |
| Batch lifecycle | [BatchAuction.sol](contracts/src/BatchAuction.sol) | Schedule, commitment records, deposits, reveal, padding, slashing |
| Price and settlement | [BlindfoldSettlement.sol](contracts/src/BlindfoldSettlement.sol) | Uniform-price fills, residual swap, marginal-price check, payouts, expiry |
| Pool authorization | [SealedPoolHook.sol](contracts/src/SealedPoolHook.sol) | Restrict pool swaps to the settlement contract |
| Aqua execution primitive | [swapvm](contracts/src/swapvm/) | Custom instruction and composed router |
| Private funding model | [ReservationModel.t.sol](contracts/test/ReservationModel.t.sol) | Executable model of cumulative private input accounting |
| Admission proof prototype | [proof-bench](packages/proof-bench/README.md) | Native relation, standard ciphertext interoperability, zkVM guest and host |
| Court evidence | [SandwichCourtVerifier.sol](contracts/src/court/SandwichCourtVerifier.sol) | Authenticate block, transactions, receipts and sandwich predicate |
| Evidence builder | [court-watcher](packages/court-watcher/) | Discover candidates and construct claim proofs |

## 2. State ownership and custody

The vault owns token custody and account accounting. The settlement contract is its operator. Users deposit and withdraw through the vault; the operator alone changes internal balances and input locks.

For account `a` and token `t`:

```text
freeBalance(a,t) = balanceOf(a,t) - lockedOf(a,t)
withdraw allowed only when openCommitments(a) == 0
```

The configured asset model uses ordinary ERC-20 transfers with stable balances. Accounting relies on received and sent amounts matching the recorded amounts. The operator is installed once by the vault administrator. The settlement administrator initializes the pool configuration.

A commitment deposit moves from the user's internal balance to the settlement's internal balance. It is separate from the order input. On successful reveal, the revealer receives a configured bounty and the owner receives the remaining deposit. An unfunded reveal sends the remainder to the treasury; an unrevealed commitment can be slashed after its reveal window.

Input tokens stay in the vault. At reveal, funded non-padding inputs become locked. Settlement unlocks and debits filled inputs, routes the net imbalance, and credits outputs. Unfilled orders and expired batches release their locks.

## 3. Timing and lifecycle

The schedule is immutable per deployment: start time, batch length, reveal length and settlement length. The contract uses quicknet's genesis and three-second round period.

```text
commitsClose(b) = start + (b + 1) * batchLength
roundAt(t) = floor((t - genesis) / period) + 1
targetRound(b) = roundAt(commitsClose(b)) + 2
revealOpens(b) = genesis + (targetRound(b) - 1) * period
revealCloses(b) = revealOpens(b) + revealLength
settleCloses(b) = revealCloses(b) + settleLength
```

Commit admission selects the current batch. Reveal and settlement windows include their opening timestamp and exclude their closing timestamp. Expiry begins at the settlement deadline. Batch duration is a benchmark-derived deployment parameter; the test cadence is not a production latency commitment.

```mermaid
stateDiagram-v2
    [*] --> Committed: deposit and open count
    Committed --> Slashed: reveal deadline passed
    Committed --> PaddingClosed: valid zero input reveal
    Committed --> UnfundedClosed: input unavailable at reveal
    Committed --> RevealedLocked: funded nonzero reveal
    RevealedLocked --> Filled: verified settlement
    RevealedLocked --> Unfilled: limit fails at clearing price
    RevealedLocked --> Expired: settlement deadline passed
    Slashed --> [*]
    PaddingClosed --> [*]
    UnfundedClosed --> [*]
    Filled --> [*]
    Unfilled --> [*]
    Expired --> [*]
```

This diagram describes economic states. The Solidity `Commitment.status` enum stores only `None`, `Committed`, `Revealed`, and `Slashed`; batch finalization and vault accounting represent the remaining transitions.

Expiry processes funded revealed orders. Unrevealed entries close through `slashUnrevealed`. Reusing these paths keeps cleanup independent of the owner's private admission state.

## 4. Order encoding and public information

An order contains:

```solidity
struct Order {
    address owner;
    bool zeroForOne;
    uint128 amountIn;
    uint128 minAmountOut;
}
```

`zeroForOne` selects token0 input and token1 output. An input of zero is padding. The canonical plaintext and commitment are:

```text
plaintext = abi.encode(order, salt)                         // 160 bytes
orderHash = keccak256(abi.encode(chainId, settlement, batchId, order, salt))
```

The chain, settlement address and batch bind the order to its execution context. The event includes the ciphertext, commitment hash, committer, batch and target round. Ciphertext bytes are event data rather than a stored contract byte array.

Before reveal, public information includes the account, its public vault funding, commitment count and timing, fixed deposits, ciphertext and public proof inputs. The target private inputs are direction, exact amount, limit, salt, encryption secrets and cumulative input totals. After reveal, order details are public.

## 5. Private cumulative funding design

The selected funding architecture tracks actual input totals privately. It does not reserve a public maximum in both tokens for each order.

An account participates in one active batch at a time and can append several commitments within that batch. Each accepted order updates hidden cumulative totals:

```text
T0' = T0 + (zeroForOne ? amountIn : 0)
T1' = T1 + (zeroForOne ? 0 : amountIn)
T0' <= B0
T1' <= B1
```

`B0` and `B1` are public budget bounds. Admission must check them against the account's actual free balances after charging the new commitment deposit. Each new admission therefore rechecks coverage of the entire accumulated obligation, including any reduction caused by another deposit.

```mermaid
flowchart LR
    Old[Previous private totals and blinding] --> Proof[Admission relation]
    Order[New private order] --> Proof
    Bounds[Public post-deposit budget bounds] --> Proof
    Proof --> New[New blinded root]
    Proof --> Hash[Order and ciphertext digests]
    New --> Next[Next admission uses this root]
```

The model and prototype use a Keccak commitment over ABI words:

```text
root = keccak256(abi.encode(
    chainId, settlement, owner, batch,
    total0, total1, blinding, step
))
```

Initialization uses zero totals, zero previous blinding and zero previous root. Subsequent admission proves an opening of the stored root. Fresh private blinding hides totals. The step binds progression, including padding. Integer checks bound totals by `64 * (2^128 - 1)` and reject arithmetic overflow.

During the commit window, open commitment count increases monotonically and can supply the step. After admission closes, totals stay append-only: revealing or settling an order does not decrement the private reservation. When all commitments close, the next batch starts from zero. No per-order private release proof is part of this design.

The accounting model executes this policy against the existing auction and vault. It uses plaintext witnesses for testing. The proof prototype checks the private arithmetic relation separately. The production integration boundary is an admission function that atomically charges the deposit, checks current state and budgets, verifies the proof, updates the root and creates the commitment.

## 6. Full ciphertext admission relation

The prototype preserves standard tlock/AGE format and uses the pinned quicknet key and chain identifier. It exposes the upstream tlock computation with explicit private randomness (`sigma`).

The relation checks both the timelock key wrapper and the authenticated payload:

```mermaid
flowchart TB
    Secrets[Private file key and sigma] --> Wrap[Recompute standard tlock key wrapper]
    Round[Bound quicknet key and round] --> Wrap
    Cipher[Ciphertext] --> Digest[Check public ciphertext digest]
    Cipher --> Match[Compare tlock stanza and arguments]
    Wrap --> Match
    Match --> AGE[Authenticate AGE header and decrypt full payload]
    Secrets --> AGE
    AGE --> Plain[Compare exact canonical order and salt]
    Plain --> OrderHash[Check public order hash]
    Plain --> Funding[Check cumulative funding transition]
    Funding --> Journal[Commit public statement to proof journal]
    OrderHash --> Journal
    Digest --> Journal
```

This allows AGE to generate its ordinary file key and payload randomness while proving that the published ciphertext decrypts to the committed order. The checker only supplies the private file key to AGE after the tlock stanza matches the recomputed wrapper. AGE then authenticates its header and entire payload.

| Public statement in prototype | Private witness |
|---|---|
| Chain ID, settlement, owner | Direction, amount, minimum output, salt |
| Batch, round, step | Previous totals and blinding |
| Old root, new root | New blinding |
| Budget bounds | File key and tlock sigma |
| Order and ciphertext digests | Ciphertext bytes checked against the public digest |

The deployment context must bind the token pair, deposit rules, proof program and network configuration. The caller's owner, current batch, scheduled round, current root and actual budget coverage are contract-side checks. A proof of a self-consistent statement is accepted only when that statement matches current contract state.

The benchmark also offers an optional accelerated BLS12-381 backend. It preserves quicknet key-wrapper bytes and uses the same AGE and funding checks. Its adapter is compared against the pinned tlock implementation over varied keys, randomness and rounds; each guest variant has a distinct program identity. See the [benchmark commands](packages/proof-bench/README.md#optional-accelerated-curve-backend).

The CLI runs proving on a user-controlled machine. The benchmark host forces local IPC and disables development receipts. The guest runs the native checker and journals the public statement. The host supports receipt persistence, verification, tampered-journal rejection and a separate Groth16 wrapping command. Its journal currently follows the Rust SDK serialization used by the prototype.

### Selected local admission construction

The admission implementation target uses two specialized local circuits with direct Groth16 verification. The RISC Zero checker remains the executable reference for standard tlock/AGE compatibility. The circuit prototype lives in [`packages/proof-bench/circuit`](packages/proof-bench/circuit/README.md).

1. **Prepare locally for a future batch.** Generate a fresh 16-byte file key, 16-byte sigma and independent 32-byte commitment blinding from the operating system CSPRNG. Prove standard quicknet tlock wrapping and the hiding commitment binding chain, settlement, owner, batch, exact round, network, wrapper and key. The round's hash-to-curve calculation is inside this proof. Each preparation belongs to one eventual order ciphertext.
2. **Choose and prove the order locally.** Build a canonical single-recipient AGE file carrying the five-word ABI payload. Prove its full authentication/encryption, the prepared-key commitment, order hash, ciphertext digest and private cumulative funding transition. Round formatting, base64, header MAC, payload key derivation and final-chunk authentication are constrained. No private witness is sent to a service.
3. **Admit atomically.** The existing opaque `admit(..., bytes proof)` seam carries both proofs and their canonical statements. Settlement requires exact statement lengths, matches their shared 256-byte prefix, checks deployment/caller/batch/round/current funding state and post-deposit capacity, derives the proof inputs and verifies both proofs under pinned verification keys. The state update and existing commitment creation occur only if every check succeeds. With admission enforcement enabled, `commit` cannot bypass the proofs.
4. **Reveal and settle through the existing lifecycle.** Any keeper can decrypt the onchain ciphertext after the authenticated beacon arrives. Reveal, uniform-price settlement, expiration and accounting retain their existing responsibilities.

There is no required proving server, shared-round proof publisher, preparation registry or trusted admission operator. A stateless verifier has no authority to choose the caller, schedule, root or budgets; settlement obtains those from its own state. Per-owner active batch and funding root protect aggregate reservations, and the existing open-commitment count supplies the step and withdrawal lock. Once all commitments close, the next admission starts from canonical zero state.

Preparation journals contain eight ABI words: domain, chain, settlement, owner, batch, round, key commitment and pinned network configuration digest. Online journals add step, old root, new root, budget0, budget1, order hash and ciphertext hash. The two proof inputs for each journal are the high and low 128-bit halves of its Keccak digest. The current online circuit also binds the similarly split digest of its ten-word funding statement; settlement derives that statement from the online journal. Byte encodings and executable commands are specified in the circuit README and the existing independent interop checker.

Both verification keys and their circuit/encoding versions are fixed deployment configuration. Production Groth16 parameters are established through a reviewed multiparty setup ceremony with at least one honest contributor erasing its contribution; clients obtain the authenticated proving parameters for those verification keys. Ceremony parameters are public distribution artifacts, not an online proving service. Benchmark-generated single-party setup parameters are used only for testing.

Preparation is independent of order selection. The client serializes admissions against the current root and step; the CLI supports advance preparation through `prepare-admission <batch-id>` (REVIEW R6). It keeps one ready preparation in the existing locked private state, checks its context and parameter manifest, and durably removes it before online encryption. State exports omit ready keys so restoring a backup cannot reuse them for another order. An interrupted online attempt requires fresh preparation; a completed pending submission retains its existing ciphertext/proof for resume. It updates its private funding opening after confirming inclusion. An identical ciphertext can be retransmitted or reproved against eligible updated funding state; a changed order or target batch consumes a fresh preparation. The preparation circuit's eight-candidate scalar derivation admits only the standard first valid nonzero candidate; exhausted or zero outcomes require fresh randomness before preparation. The client submits only when proving and inclusion fit before the fixed deployment's commit deadline. Batch selection never changes the scheduled release round after proof creation.

Order contents remain private from observers until release, subject to the pinned beacon's threshold assumption. The sender knows its own order and may disclose it. Owners, timing, public vault activity and ciphertexts remain observable. Correct encryption guarantees decryptability when the beacon is available; keeper participation and timely beacon delivery are separate liveness requirements.

## 7. Commit-to-settlement sequence

```mermaid
sequenceDiagram
    actor User
    participant CLI
    participant Proof as Local prover
    participant Admission as Target admission entry point
    participant Vault
    participant Keeper
    participant Beacon as drand
    participant Settlement
    User->>Vault: Deposit tokens
    CLI->>Admission: Read batch, root, balances and configuration
    CLI->>CLI: Encrypt order and construct next private state
    CLI->>Proof: Prove ciphertext and funding relation
    Proof-->>CLI: Receipt and public statement
    CLI->>Admission: Submit ciphertext, hash, statement and proof
    Admission->>Vault: Charge deposit and validate remaining budget
    Admission->>Admission: Verify proof and current-state bindings
    Admission->>Vault: Increment open commitments
    Admission-->>Keeper: Commitment event
    Beacon-->>Keeper: Target round signature
    Keeper->>Keeper: Verify beacon and decrypt
    Keeper->>Settlement: Reveal order and salt
    Settlement->>Vault: Reward reveal and lock input
    Note over Settlement: After reveal window closes
    User->>Settlement: Propose clearing price (permissionless)
    Settlement->>Settlement: Verify fills, residual and marginal price
    Settlement->>Vault: Credit outputs and close commitments
```

The existing contract exposes `commit(batchId, hash, ciphertext)`. The sequence's proof-backed admission entry point is the integration design. The two paths must not coexist as alternative ways to create accepted commitments once proof enforcement is enabled.

## 8. Uniform-price settlement

Prices use raw token units:

```text
p = token1 per token0 * 2^96
sell output = floor(amountIn * p / 2^96)
buy output  = floor(amountIn * 2^96 / p)
```

An order fills when its quoted output is nonzero and meets its minimum. The solver proposes a price; the contract derives the fill set from that price.

Settlement collects filled inputs, computes aggregate obligations and routes one exact-input residual through the sealed v4 pool. The swap must consume the complete residual and return enough to cover owed outputs. Surplus residual output is donated to in-range LPs. The final pool marginal price must satisfy:

```text
abs(poolPrice - proposedPrice) * 10_000 <= toleranceBps * proposedPrice
```

Only after those checks does settlement credit user outputs and close commitments. EVM transaction atomicity rolls back transfers, locks and finalization when any check fails. `expire` provides the existing deadline path for releasing funded revealed inputs.

The hook authorizes settlement as swap caller. Liquidity provision remains a separate pool operation. Deployment creates the settlement first, mines the hook's CREATE2 address with the required permission bits, then initializes the settlement's pool key.

## 9. Aqua / SwapVM boundary

`SealedClearing` reads the settlement's transient active clearing price and requires the settlement as taker. The composed router appends this instruction to the Aqua opcode set. Its opcode is obtained from `sealedClearingOpcode()`.

The settlement exposes the price only during settlement and returns its inverse for the opposite token direction. The current residual implementation routes through v4; Aqua residual routing is a target integration using the existing instruction. Strategy execution and settlement routing are distinct components.

## 10. Court evidence architecture

Court verifies historical evidence independently from the encrypted auction. A claim supplies a block header and front, victim and back transaction legs. Each leg includes transaction bytes, trie proofs, receipt proofs and a log index.

```mermaid
flowchart TB
    Local[BLOCKHASH or EIP-2935] --> Known[Authenticated target block hash]
    Base[Base L1Block checkpoint] --> Anchor[Authenticate L1 anchor header]
    Anchor --> State[Prove EIP-2935 account and storage]
    State --> Known
    Known --> Header[Authenticate target header]
    Header --> Tx[Transaction trie proofs and signer recovery]
    Header --> Receipt[Receipt trie proofs and selected swap logs]
    Tx --> Predicate[Ordering, identity, direction, closure and positive profit]
    Receipt --> Predicate
    Predicate --> Verdict[Block, victim hash, attacker, victim, profit token side and amount]
```

The predicate requires transaction indices `front < victim < back`, front and victim in the same direction, back in the opposite direction, closing size within the configured tolerance, the same front/back signer, a distinct victim signer, and positive attacker swap-leg profit.

The verifier supports legacy and typed transaction signer recovery. It normalizes v4 swap amounts to the pool-side convention used by its predicate. The local Optimism-derived trie/RLP utilities retain attribution; the RLP list reader grows to handle receipts with many logs.

For anchored verification, a checkpoint records an L1 block hash reported by Base's `L1Block`. Account and storage proofs against that anchor recover the historical target hash from Ethereum's EIP-2935 state. The watcher builds these proofs while the RPC can serve the required state.

### Compensation policy boundary

The selected policy is profit-based compensation with token valuation and payout caps. Court's raw swap-leg profit is denominated in the relevant token; it is not automatically an ETH amount or a measurement of victim loss.

The proposed compensation layer binds a signed protection receipt to the verified victim transaction and source chain, authenticates pool/token configuration, values eligible profit, applies policy caps and pays from the accountable provider's bond. Receipt authentication, replay consumption, claim timing, bond withdrawal rules and payout accounting belong to that layer. `verify` itself returns a verdict and performs no payout.

A historical valuation near the incident is an architecture proposal. Feed selection, bond denomination, exact caps and valuation rules require a concrete policy before compensation integration. The older illustrative payout expression in product notes is not an implemented compensation API.

## 11. Discovery, availability and service roles

| Role | Input | Output | Authority |
|---|---|---|---|
| CLI | User order, chain state, local private state | Ciphertext and admission proof | User's signing authority |
| Keeper | Commitment events and beacon signatures | Reveal/slash/expiry calls | Permissionless lifecycle calls |
| Solver | Revealed orders and pool state | Candidate clearing price | Contract checks settlement |
| Court watcher | Ethereum transactions, receipts and proof RPC data | Court claim | Verifier checks evidence |
| Arkiv integration | Events and confirmed outcomes | Discoverable commitments and verdict views | Read/discovery layer |
| Swarm integration | Ciphertext bytes | Content reference | Availability layer |

Onchain state determines balances and outcomes. Index records are discovery aids, not authorization. The ciphertext event provides a canonical publication path. A keeper can reconstruct work from chain events rather than treating an index status as truth.

## 12. Verification workflow

Run shell setup first because this machine defines a recursive `node` function:

```sh
source env.sh
(cd contracts && forge test)
(cd contracts && forge test --match-path test/ReservationModel.t.sol --fuzz-runs 4096)
bash packages/proof-bench/prepare.sh
cargo test --manifest-path packages/proof-bench/Cargo.toml --locked --release
npm ci --prefix packages/proof-bench --ignore-scripts
mkdir -p packages/proof-bench/results
cargo run --manifest-path packages/proof-bench/Cargo.toml --locked --release > packages/proof-bench/results/native.json
node packages/proof-bench/interop.mjs packages/proof-bench/results/native.json
(cd packages/proof-bench/evm && forge test -vv)
```

The [benchmark README](packages/proof-bench/README.md) supplies execution, proving and wrapping commands. Validation is layered:

1. Native relation tests check arithmetic, state transitions and malformed inputs.
2. Independent JavaScript decryption checks standard tlock compatibility and ABI hashes.
3. Guest execution checks that the exact relation runs inside the selected VM.
4. Real proof generation verifies the receipt and submitted journal with development mode disabled.
5. Groth16 wrapping produces an EVM-compatible seal for the same receipt.
6. Solidity verification checks that seal against the intended program and journal; altered inputs must reject.
7. Admission integration checks actual sender, schedule, root, balances and atomic rollback.
8. Repeated end-to-end measurements inform batch cadence and sequential account throughput.

The checked-in Solidity fixture test uses an upstream receipt. Its purpose is verifier plumbing; admission proof verification uses the admission guest's own program identity and receipt. Execution time, proving time, wrapping time and transaction verification gas are different measurements.

## 13. Build and dependency boundaries

- Core contracts compile alongside v4 `PoolManager` with Solidity 0.8.26. Transient storage uses `tstore`/`tload` assembly.
- SwapVM files use their own 0.8.30 and via-IR compilation restrictions.
- The Rust benchmark, zkVM workspace and Solidity verifier benchmark are isolated from production contracts.
- `prepare.sh` pins upstream tlock and RISC Zero verifier revisions. Lockfiles preserve Rust and JavaScript dependency resolution.
- The tlock patch exposes explicit randomness while retaining upstream encryption and attribution. AGE authentication uses the upstream library.

Primary implementation references: [drand tlock](https://github.com/drand/tlock), [tlock-rs](https://github.com/thibmeu/tlock-rs), [tlock-js](https://github.com/drand/tlock-js), [RISC Zero](https://github.com/risc0/risc0), [RISC Zero Ethereum verifier](https://github.com/risc0/risc0-ethereum), [Uniswap v4 core](https://github.com/Uniswap/v4-core), and [EIP-2935](https://eips.ethereum.org/EIPS/eip-2935).


## Peer-only matching when active liquidity is zero

`settlePeer(batchId, marginalId, marginalAmountIn)` crosses opposing funded orders without a pool swap. The contract reads the validated external reference ending at the batch reveal deadline and requires the sealed pool's active liquidity to be zero. The representative identifies the price-priority boundary: eligible better same-side limits fill fully, equal limits share the input fraction, and worse limits remain unfilled. The boundary fraction may be 100%; zero-minimum orders are supported. Opposing orders retain the ordinary quote rule.

```mermaid
flowchart LR
    A[Zero active liquidity] --> B[Stored pool price]
    B --> C[Price priority and proportional fills]
    C --> D[Check minimums and both token budgets]
    D --> E[Distribute rounding surplus]
    E --> F[Pay traders and unlock unused input]
```

Each base output is rounded down at the reference price, while its proportional minimum rounds up. Execution requires nonzero opposing payouts and independently sufficient token0 and token1 inputs. Rounding surplus is distributed to recipients of that token in proportion to their base quoted outputs; the smallest commitment ID receives the final indivisible remainder. Actual payouts appear in `Filled`, and `PeerSettled` records the reference price and aggregate rounding surplus. The existing finalization, commitment cleanup, and expiration lifecycle applies.

The solver tries this local crossing first when the liquidity view is zero, validates the candidate onchain, and simulates again before sending. It retains AMM search if no peer candidate succeeds; liquidity can exist beyond the current tick even when active liquidity is zero.

### Ethereum public-pool execution

An external market is configured once, after token initialization and before the
first commitment. The settlement checks its token pair and settlement address.
Its configuration cannot change while users have orders pending.

```mermaid
flowchart LR
    O[Revealed orders] --> P[Price priority and proportional allocation]
    V3[Authenticated Uniswap v3 pool] --> R[Historical reference ending at reveal deadline]
    R --> G[Reference validation and clearing-price band]
    G --> P
    P --> C[Cross opposing inputs]
    C -->|Residual| V3
    V3 --> B[Verify actual output covers promised payouts]
    C -->|Peer-only, both budgets covered| B
    B --> U[Vault credits: quoted output plus surplus]
```

`UniswapV3Market` authenticates one pool against its factory. `referencePriceX96(batch)`
uses the geometric mean price over a fixed historical window ending at the reveal
deadline. It checks available observation history, harmonic mean liquidity,
latest observation age, reference age and current spot deviation. Negative mean
ticks round down, following Uniswap's OracleLibrary. Prices stay in raw
token1/token0 Q96 units; Ethereum USDC is token0 and WETH is token1.

`settlePeer` now uses this reference and still requires zero active sealed-pool
liquidity. It never substitutes the stored private-pool price. The original
`settle` path requires active sealed-pool liquidity, including balanced batches.

`settleExternal(batch,price)` uses the same collection, user-limit checks, vault
accounting and finalization as sealed settlement. A four-argument overload adds
the existing proportional boundary group. The proposed price must lie inside the
configured external reference band. Only the unmatched exact input goes to the
fixed public pool. The callback authenticates the pool and limits payment to that
input. The settlement verifies the actual output balance increase and returns all
surplus to output recipients. A short or partial swap reverts the transaction;
normal expiry remains available.

This public route uses existing LP liquidity without requiring LP commitments to
Blindfold. It does not use the sealed pool's post-swap marginal-price condition or
donate surplus to its LPs. `ExternalSettled` identifies this execution policy;
`PeerSettled` identifies peer execution. `Filled.amountOut` includes returned
surplus for both modes.

The Ethereum fork fixture resolves the USDC/WETH 500-fee pool from the canonical
factory at block 26,353,874. Its test parameters are a 600-second window,
30-second maximum reference delay, 120-second observation-age limit, minimum
harmonic liquidity of 10^15, and a 100-basis-point deviation band. These are
explicit fixture parameters. The fork exercises real token transfers and public
pool swaps with zero liquidity in the sealed pool, in both directions.

### General routing for pair-specific auctions

A market still accepts orders for one endpoint pair. `UniswapV3Route` implements
the existing external-market interface with one to three fixed Uniswap v3 hops.
The endpoints need not share a direct pool. For example, WBTC/USDC orders can
cross internally, then execute their residual through WBTC/WETH and WETH/USDC.

```mermaid
flowchart LR
    O[WBTC / USDC batch] --> C[Cross opposing endpoint orders]
    C --> R[UniswapV3Route]
    R --> H1[WBTC / WETH pool]
    H1 --> H2[WETH / USDC pool]
    H2 --> V[Validate received USDC and credit vault]
    P1[First hop historical reference] --> P[Compose endpoint reference]
    P2[Second hop historical reference] --> P
    P --> C
```

The constructor receives the settlement, factory, ordered token path, pool and
liquidity/activity configuration for each hop, a common historical window and
maximum delay, and the deviation band. Endpoint addresses must be sorted:
`path[0] = settlement.token0`, `path[last] = settlement.token1`. Intermediate
addresses can be in either order. It rejects duplicate tokens, discontinuous
pools and paths longer than three hops. Each pool is authenticated against the
configured factory by the existing single-pool adapter.

Every hop observes the same historical end time. References are inverted when a
hop runs opposite its pool's token order, then composed in raw-unit Q96 arithmetic.
Per-hop history, liquidity, activity and spot checks remain in force. The composed
spot/reference deviation must also fit the band. This prevents several individually
acceptable deviations from exceeding the endpoint policy when multiplied.

Execution checks that the adapter actually receives the exact residual input before prefunding the first hop. Each hop pays its
own authenticated callback and passes only its measured output to the next hop.
Reverse orders traverse the same path backwards. The last hop enforces the final
minimum output; settlement independently measures the endpoint tokens received.
A failed hop reverts the entire transaction. Intermediate tokens never enter the
user's vault balance. Unrelated donated balances are not included in route output.
Transfers between adapters and to settlement must change both balances by the
expected amount.

Deployment sequence:

1. Deploy the pair's vault, settlement and sealed hook; initialize the existing
   pair key as usual. Each pair retains its own vault and operator.
2. Resolve each proposed hop with the intended chain's canonical v3 factory and
   select per-hop liquidity/activity thresholds. Supply token and pool addresses
   as constructor configuration, not solver-selected arbitrary calldata.
3. Deploy `UniswapV3Route` and call `settlement.configureExternal(route)` before
   accepting any commitments. Read the batch reference and simulate both directions.
4. Publish the ordinary pair deployment record. The solver reads the generated
   settlement ABI and external reference; it requires no new routing arguments.

The order format, commitment domain, proof endpoint assets and settlement entry
points are unchanged. A preparation remains bound to its original settlement;
route support does not make proofs reusable across different pair deployments.

Partial allocations retain the ordinary floored common fraction when the output
covers the user's ceil-rounded minimum. If it does not, the input falls back to
whole reduced amount/minimum lots; an empty fallback stays unfilled. This behavior
is shared by sealed, peer and routed settlement. The solver uses the largest order
in a limit group as its representative to preserve fraction resolution.


## 14. Global multi-token auctions

### Scope and state ownership

`contracts/src/global/GlobalAuction.sol` is the sole operator of a `BlindfoldVault`. One deployment fixes a sorted registry of 2–8 token addresses, up to 64 authenticated route adapters and 64 commitments per batch. Registry bounds make funding proofs, allocation checks and cleanup bounded. The registry and routes freeze before admission; tokens outside that registry can still appear as intermediate assets inside an authenticated route.

The pair implementation remains a separate compatible deployment path. A global deployment needs its own vault operator assignment and versioned proofs. Depositors fund one shared balance per token; they do not distribute capital among pair vaults or deposit route intermediates.

```mermaid
flowchart LR
    U[User CLI] -->|deposit once per token| V[Shared BlindfoldVault]
    U --> P[Local preparation + global online prover]
    P -->|two proofs and encrypted global order| G[GlobalAuction: sole vault operator]
    G <-->|balances / locks / open commitments| V
    D[drand signature] --> K[Permissionless revealer]
    G -->|ciphertext event| K
    K -->|owner, token indices, amounts, salt| G
    S[Global solver CLI] -->|one price vector + fractions + routes| G
    O[Historical base-token oracle paths] --> G
    G -->|batch surplus only| R[Registered UniswapV3Route adapters]
    R --> A[Authenticated public v3 pools]
    A -->|measured output| V
    G -->|atomic payouts and rebates| V
```

`GlobalAuction` owns commitments, orders, per-owner reservation roots/steps, batch finality and route configuration. The vault owns real tokens, internal balances, input locks and open-commitment counts. The prover owns private cumulative totals and blinding. No registered route has vault operator authority. Routes receive only prefunded surplus for a specific settlement call.

Deposits and external vault transfers check real balance changes; short transfers cannot mint internal credit. Donations remain outside batch budgets. Callback-bearing transfers cannot reenter vault deposit/withdraw/push/pull or global auction actions.

### Global order and funding relation

```text
Order = (owner, uint8 tokenIn, uint8 tokenOut, uint128 amountIn, uint128 minAmountOut)
registryHash = keccak256(abi.encode(address[8] paddedTokens))
orderHash = keccak256(abi.encode(
    keccak256("blindfold.global.order.v1"), chainId, auction,
    registryHash, batch, Order, salt
))
```

Token indices refer to the immutable sorted registry. The global plaintext contains the entire order and salt. The online circuit constructs the complete canonical AGE ciphertext and proves its digest; the preparation circuit proves the key wrapper for the target drand round. `GlobalAdmissionVerifier` checks both generated Groth16 verifiers against digests derived by the auction.

For each owner and batch, the private reservation state contains eight cumulative input totals. Admission increases exactly the selected input token's total, proves every total fits the current budget and binds the resulting hiding root. The onchain budget excludes this admission's deposit and nonrefundable fee, both charged in registry token 0. An owner can have commitments in only one unresolved global batch. Withdrawals stay blocked while any commitment is open; new deposits can increase available budgets. The vault does not reserve a public capacity in both sides of each pair.

There is no global unproved `commit` entry point. A pair proof cannot substitute for a global proof: the order, registry, funding root, online domain and public-input arity differ. Preparation remains reusable within its bound owner/auction/batch/round context; online encryption uses fresh nonce and reservation blinding.

### Lifecycle and timing

```mermaid
stateDiagram-v2
    [*] --> Committed: valid proofs + current batch + fee/deposit
    Committed --> Revealed: anyone supplies matching plaintext in reveal window
    Committed --> Closed: unrevealed slash after reveal window
    Revealed --> Closed: atomic settlement or expiry
    Closed --> [*]: decrement owner and vault open counts
```

Batch cadence and start align with drand's three-second rounds. Settlement windows cannot overlap. `admit` records ciphertext; `reveal` locks the exact input and pays the fixed bounty/refund. `settle` or `settleAtPrices` unlocks all revealed inputs, collects actual fills and closes those commitments atomically. Unrevealed entries remain individually slashable even after a batch settles. `expire` handles all remaining revealed and unrevealed entries in a bounded loop. Once an owner's open count reaches zero, withdrawals and participation in another batch are possible.

### One price vector, including cycles

Token 0 is the numeraire. Each other token has an authenticated path to it, queried over the same historical window ending at the commit deadline. `prices(batch)` returns raw base-token value per token, scaled by `2^96`; token 0 is exactly `2^96`. Token decimals are not assumed to equal 18.

For input `x` of token `i` buying token `j`:

```text
output = floor(x × price[i] / price[j])
required minimum = ceil(order.minAmountOut × x / order.amountIn)
```

`settle` uses the historical vector directly. `settleAtPrices` permits a proposed vector within each oracle's immutable deviation band, retaining the fixed numeraire and zero unused slots. This allows pool fees to fit inside user limits without choosing inconsistent prices independently for each pair. Price validation and every user minimum are enforced onchain. A zero price explicitly excludes a non-base token: all orders involving it must have zero fractions. The solver can therefore leave a stale market unfilled while healthy pairs settle, without inventing a fallback price.

```mermaid
flowchart LR
    A[A seller contributes A] -->|A buys B at pA/pB| B[B seller contributes B]
    B -->|B buys C at pB/pC| C[C seller contributes C]
    C -->|C buys A at pC/pA| A
```

A balanced cycle requires no pool execution. The same vector determines all three exchange ratios. The solver submits fractions in commitment order, with denominator `2^128−1`, giving unit resolution for every uint128 order size. Equal exact limits within a directed pair require equal fractions; any filled worse limit requires full fractions at better limits. Ineligible orders have zero fractions. A partial allocation that misses its rounded minimum falls back to exact reduced-ratio lots, as in the approved pair allocation refinement. Zero-output dust stays unfilled.

### Conservation, routing and surplus

Settlement computes `incoming[token]` and `owed[token]` from the entire batch before routing. A route may spend only `available[input] − owed[input]`, and only acquire a token with an outstanding deficit. Routes are bounded, pre-registered and authenticated; the solver cannot inject arbitrary targets or calldata. A route adapter can contain up to three pools, so intermediates do not require auction-level prefunding.

After every route, actual balance changes update the available budget. Every token must cover its payouts before any order is finalized. Failure in the final route reverts all earlier routes, input collection and unlocks. Existing auction deposits and donated balances cannot cover a batch deficit.

Remaining surplus is returned proportionally to contributors of that token. When an acquired token had no input contributors, its output recipients receive the surplus. Cumulative division allocates every integer unit deterministically. `Filled` reports the uniform-price trade; `Rebate` separately reports returned surplus.

### Local tools, deployment and verification

`packages/global-auction` supplies admission/reveal/cleanup commands, a bounded global solver, simple-path discovery and deployment tooling. It loads generated artifacts. Deployment requires explicit chain identity, reviewed preparation/global verifier addresses, sorted tokens, oracle paths, execution routes and schedule/economic parameters. It installs the one vault operator, registers paths and seals configuration.

`packages/proof-bench/src/bin/global-prepare.rs` creates a fresh private preparation witness using OS entropy. The Go circuit CLI supports reusable proving keys bound to the serialized circuit identity; an ordinary subsequent proof loads existing keys instead of creating a new verifier. Preparation and online keys remain distinct.

Verification commands and private file formats are documented in `packages/global-auction/README.md` and `packages/proof-bench/circuit/README.md`. Contract tests cover cycles, per-token conservation, mixed raw-unit prices, fraction fairness, fee-aware price vectors, maximum batches, callback/transfer boundaries, rollback and cleanup. Fork tests execute real WBTC/WETH/USDC routes. A separate real-proof harness exercises actual admission, settlement and withdrawal, and independent tlock-js decryption recomputes the global ABI hashes. Current measurements and review/deployment gates are recorded in REVIEW.md.
