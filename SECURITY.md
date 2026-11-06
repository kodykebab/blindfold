# Security policy and research backlog

Updated: 2026-11-07. Evidence baseline: `6dc083e` on `kritarth/sandwich-experiment`, with production sources inherited from `8b5f8ca`. This document consolidates the concerns discussed during integration and execution-security research. It is not a completed repository audit, an assurance of production readiness, or approval to deploy funds.

The requested research backlog is intentionally recorded here. [REVIEW.md](REVIEW.md) remains the historical design-review record; [PLAN.md](PLAN.md) remains the implementation and ownership tracker. Historical issue titles are not evidence that the current version still contains the original bug. Revalidate against explicit commits before changing statuses.

## Scope and assets

Covered surfaces:

- Pair auction, vault, hook and market adapters in `contracts/src/`.
- Enforced admission and funding state in `contracts/src/admission/`, and circuits, prover, parameters and CLI in `packages/proof-bench/`.
- Client, keeper and solver packages, generated ABIs, deployment manifests and deployment scripts.
- Global auctions and shared custody in `contracts/src/global/`, assessed separately from the pair-auction release.
- Court verification, coverage signatures, bonds, claims and watcher in `contracts/src/court/` and `packages/court-watcher/`, assessed separately from auction execution.
- Aqua integration, indexing, browser/local-helper boundaries and operational dependencies when included in the intended release.

Assets include deposited tokens, reserved input, output proceeds, admission-state openings, proof parameters, wallet credentials, bond balances, covered beneficiaries' claims, order confidentiality before reveal, and the ability to exit after failure.

Third-party cryptography, token contracts, pools, drand, RPC providers and chain consensus are dependencies. Their use, configuration and failure handling remain in scope. A passing pair-auction test does not validate global auctions, Court, or Aqua.

## Threat model and trust boundaries

Assume malicious traders, multiple coordinated accounts, competing or compromised solvers and keepers, LPs who also trade, and parties able to reorder or omit transactions. Consider collusion across those roles. Ordinary outages, stale RPC responses, transaction replacement and chain reorganization also matter.

- **Trader/client → admission:** proof and ciphertext inputs, local state, quote sources and signatures must agree with chain state. Unchecked development deployments are a different security mode.
- **Admission → reveal:** drand publication is wall-clock based; chain timestamps and inclusion can lag. Confidentiality relies on the encryption and beacon assumptions, not merely a scheduled timestamp.
- **Reveal → settlement:** order contents become public. Permissionless execution does not prevent selective participation, price discretion, market manipulation or censorship.
- **Settlement → external pools:** public liquidity is mutable. A user minimum, reference-price band or successful simulation does not by itself eliminate profitable ordering strategies.
- **Vault → operators/adapters:** external execution must never expose unrelated deposits, bypass reservations or leave debts subsidized by other users.
- **Operators → availability:** initially team-operated services can share hosts, RPCs, funding and implementation bugs. Keeper fallback to the same solver is not independent operation.
- **Deployment authority → live configuration:** enumerate the actual authority over initialization, verifiers, operators, tokens, routes and other settings. Do not assume either universal immutability or an upgrade mechanism without source evidence.
- **Court evidence → payout:** proving a supported transaction pattern does not prove provider leakage or the victim's complete economic loss.

## Required invariants

These are review requirements, not assertions that every path has been proven correct.

1. Vault credits and liabilities remain backed by supported assets; unauthorized callers cannot withdraw, redirect or reuse another account's funds.
2. Admission binds the caller, chain, deployment, batch, round, ciphertext/order commitments, proof identities and funding transition. Enforced deployments have no unchecked bypass.
3. Failed admission, reveal or settlement leaves no partial funding-root, reservation, payout or adapter mutation.
4. Execution respects user limits for the actual filled amount, with specified integer rounding and consistent equal-limit allocation. Fees and surplus have explicit recipients.
5. A batch cannot finalize twice or reuse inputs across overlapping operations. Cleanup is bounded and does not depend exclusively on team services.
6. Supported external routes spend only authorized batch funds and cannot make unrelated balances cover an output deficit.
7. Order contents and private state do not leak through logs, indexing, quote requests or helper APIs before their intended disclosure boundary.
8. Court payments respect authenticated coverage, beneficiary binding, source-chain evidence, incident accounting and available bonds; claims cannot be collected twice.
9. User-visible status distinguishes submitted, included, finalized, revealed, filled, partially filled, expired and released outcomes. An uncertain transaction must not cause duplicate submission.

## Claims and evidence status

No blanket “MEV-proof,” “sandwich-proof,” optimal-execution, guaranteed-fill or fully decentralized-operation claim is established by this work. A narrower claim must identify the execution path, attacker capabilities, timing assumptions and measured or proven property.

### Completed experiment E1

[ExternalSandwichFork.t.sol](contracts/test/ExternalSandwichFork.t.sol), introduced in `6dc083e`, exercises the real USDC/WETH 500-fee pool on an Ethereum fork at block **26,358,272**. A real preparatory round trip refreshes the pool's activity observation before comparisons. This is a controlled scenario using historical liquidity, not a historical incident reconstruction.

- 36 sampled scenarios cover two order sizes and both directions.
- For the smaller orders, all 14 successfully settled sampled round trips lose after pool fees, before gas.
- For the larger orders, all 14 successfully settled sampled round trips profit before gas; eight other scenarios across the two size sweeps reject under existing controls.
- A test-only output floor of two basis points below the clean execution quote rejects 10 of the 14 profitable larger-order scenarios and permits four.
- A floor recalculated after the preceding price movement accepts the degraded result in every successfully settled scenario tested.
- Clean execution and rollback checks pass. The full Solidity suite at that experiment revision passed 557 test executions, including inherited tests.

**Evidence limits:** E1 uses contract-permitted band-edge clearing proposals, not the solver CLI's selected proposals. It does not include gas, builder payments, capital costs, LP fee recovery, multi-hop strategies or live benign-motion rejection rates. The guard is a bypassable test wrapper, not a deployed invariant. The sampled grid is not an exhaustive profit bound. Later uncommitted harness files are not covered by the 557-test result.

### Unfinished experiment E2

The actual-solver follow-up is unfinished. Local draft files `contracts/test/ExternalSandwichActor.sol` and `contracts/test/solver-sandwich.mjs` were created, but produced no validated solver-level result. The attempted run stopped at a local fork chain-ID mismatch before the scenario executed. Review and repair the harness under SEC-01; do not cite it as evidence for protection or vulnerability of the CLI.

### Previously implemented controls requiring regression review

Current integration includes enforced admission, cumulative private funding state, proportional fills, nonrefundable commitment fees, schedule alignment, bounded settlement windows, external reference checks, expiry/release paths and client recovery features. These address parts of earlier REVIEW items. Their existence does not close the remaining tasks below. Development proof parameters and recorded-round tests are not production setup or latency evidence.

## Research task backlog

Priorities describe investigation order, not vulnerability severity. **P0** covers funds, proof soundness, timing assumptions and claims needed for the proposed release. **P1** covers broader adversarial economics, availability and configuration. **P2** covers separately gated extensions. Owners are suggested from PLAN lanes, not newly accepted assignments. All checkboxes remain open until an evidence artifact and explicit disposition exist.

### Execution and MEV

- [ ] **SEC-01 — Actual solver behavior (P0; Bhoumik + Kritarth; #7/#12/#30).** Run the unchanged CLI on isolated forks; record its exact calldata, price, fill allocation, input snapshot and last simulation. Compare an unchanged submitted candidate with a fresh search after intervening market movement. Assert user accounting, partial fills and failed-submission recovery. **Done:** reproducible results separate contract acceptance from actual operator behavior, with positive and negative controls.
- [ ] **SEC-02 — Output-floor semantics (P0; Kritarth + Bhoumik; needs SEC-01).** Determine whether the proposed floor protects route output, aggregate payouts or each user's outcome. Test multiple orders, mixed directions, partial groups, rounding, surplus, direct-call bypasses and stale or manipulated quote origins. **Done:** specify the enforceable property and show whether every applicable entry point enforces it; otherwise classify it as an operator policy. Do not equate lower exposure with immunity.
- [ ] **SEC-03 — Realistic profitability and tolerance (P1; Bhoumik + Kritarth; needs SEC-01).** Expand sizes, pool depths, fee tiers, directions and market states. Include transaction costs, execution failures, builder payments and capital assumptions; distinguish gross token profit from net profit. Measure benign price movement under the same thresholds. **Done:** report sampled profitable regions, user loss and rejection/fill tradeoffs with uncertainty; no universal “safe threshold” from a sampled search.
- [ ] **SEC-04 — LP/trader collusion and liquidity timing (P0 for the sealed-pool protection claim; Kritarth + Bhoumik; R5/#18).** Analyze fees and surplus when the executor also owns in-range liquidity, including additions/removals across blocks and batches. Compare against the same LP inventory without the strategy. Test removal-induced expiry and withdrawal availability. **Done:** account for capital and LP inventory, and distinguish actual protection from merely preventing same-block actions.
- [ ] **SEC-05 — Multi-hop and mixed-batch exposure (P1; Kritarth + Bhoumik; #43).** Check each hop and coordinated hop movements, mixed-direction batches, intermediate token balances, per-hop references and final output. Compare peer crossing and residual routing without assuming minimum routed volume maximizes user welfare. **Done:** end-to-end token conservation and measured execution outcomes for each supported route; pair/single-hop conclusions are not generalized.
- [ ] **SEC-06 — Clearing discretion and completeness (P0; Kritarth + Bhoumik; R1/R4/R11, #7/#12/#30).** Review price bands, marginal selection, equal-limit priorities, dust and surplus recipients. Compare bounded search with an independent small-domain reference model. **Done:** distinguish an executable solution, best solution under a stated objective, search exhaustion and true infeasibility. Identify any contract-allowed operator advantage separately from honest solver conventions.
- [ ] **SEC-07 — Oracle integrity and quote provenance (P0; Kritarth + Bhoumik + Khush; #19/#24).** Examine the reference window ending at reveal close, spot checks, liquidity floors, stale observations, RPC freshness, decimals and compounded route bounds. Include manipulation before quoting and across the reference window. Separate indicative reference quotes from size-aware executable quotes. **Done:** supported configurations have justified bounds and fail-closed tests, with quote trust assumptions stated.

### Confidentiality, admission and custody

- [ ] **SEC-08 — Drand versus chain time (P0; Kritarth + Khush; R7/#31).** Test stalled/sequencer-controlled timestamps, delayed inclusion, late beacon publication, reorganizations and round boundaries. Determine whether commitments can be included after their encryption round is publicly available. **Done:** define the chain-specific confidentiality assumption and inclusion rule; schedule alignment alone does not close this task.
- [ ] **SEC-09 — Admission relation and verifier composition (P0; Kritarth; #29/#61).** Review real preparation/online proof binding, domains, serialization, ciphertext validity, funding budgets, replay and immutable helper/verifier configuration. Exercise cross-account, cross-chain, cross-deployment, wrong-round and stale-root negatives with real proofs. **Done:** no enforced-mode bypass or partial state mutation, plus independent circuit/contract review evidence.
- [ ] **SEC-10 — Production proving setup and distribution (P0; Kritarth; #61/#66).** Establish reviewed circuit identities, parameter provenance, setup requirements, authenticated manifests and distribution, reproducible verifier builds and version compatibility. **Done:** production artifacts can be authenticated and independently checked; development parameters cannot accidentally satisfy a production release gate.
- [ ] **SEC-11 — Vault and private funding conservation (P0; Kritarth; #17/#23).** Review one-active-batch behavior, cumulative reservations, concurrent submissions, fee deductions, root/step progression, releases and operator permissions. Include malicious callbacks and unsupported token behavior. **Done:** invariant tests cover valid lifecycle transitions and rollback, and no account or batch can subsidize another through accounting mistakes.
- [ ] **SEC-12 — Metadata and client-side confidentiality (P1; Khush + Kritarth; #19/#25).** Trace order-specific quotes, approvals/deposits, timing, ciphertext sizes, logs, exports, backup destinations, indexers and prover inputs. Distinguish unavoidable public metadata from unintended disclosure. **Done:** document exactly what becomes visible to each party and when; test that private witnesses are not published or logged.
- [ ] **SEC-13 — Token and arithmetic domains (P0; Kritarth; #23).** Recheck supported token semantics, exact receipt accounting, decimal differences, rounding, signed swap deltas, uint128 order limits, aggregate bounds and zero/dust amounts. Include fee-on-transfer, rebasing and callback behavior as explicit unsupported/rejected cases where appropriate. **Done:** supported-token policy matches enforced checks and boundary tests, rather than relying only on UI restrictions.

### Services, recovery and deployment

- [ ] **SEC-14 — Selective reveal, censorship and availability (P0 for liveness claims; Khush + Kritarth + Bhoumik; #13/#14/#15).** Test withheld reveals, missing operators, competing submissions, service outages and batch-capacity pressure. Measure outcomes with incomplete revealed sets; do not assume permissionless reveal guarantees completeness. **Done:** document incentives, feasible delays and permissionless expiry/cleanup paths with fund-release tests.
- [ ] **SEC-15 — Independent operators and economics (P1; Khush + Bhoumik).** Run takeover from public deployment information without team private state or hosted services. Measure reveal rewards, gas budgets, solver costs and shared RPC/host dependencies. **Done:** independent reveal/settlement/cleanup is demonstrated and funding responsibilities are explicit. Keeper invocation of the same solver is not independent implementation diversity.
- [ ] **SEC-16 — Local state, finality and restoration (P0; Khush + Kritarth; #10/#16/#17/#63).** Test crashes around signing/broadcast/inclusion, nonce replacement, reorgs, duplicate app instances, stale exports, tampered backups and restored devices. Verify chain/deployment/account binding and backup-key assumptions. **Done:** reconciliation prevents duplicate accepted transitions and exposes the remaining withdrawal blockers without silent loss of private state.
- [ ] **SEC-17 — Browser/local-helper boundary (P1, before shipping that interface; Khush + Kritarth; #62).** Specify request authentication, origin restrictions, wallet consent, local API exposure, filesystem/key access and malicious-page behavior. **Done:** an unrelated page cannot trigger signing, read witnesses or change trade parameters. This task does not authorize a new helper architecture.
- [ ] **SEC-18 — Spam, bounds and resource exhaustion (P1; all lanes; R3/#9).** Evaluate commitment capacity, fee economics, large ciphertext/proof inputs, maximum order counts, parsing, solver simulation budgets and watcher scanning. **Done:** bounded work and costs are measured; fee existence is not treated as proof that sustained denial of service is uneconomic.
- [ ] **SEC-19 — Deployment and authority inventory (P0; Kritarth + all consumers; #24/#65).** Enumerate constructor and initialization checks, ownership/operator permissions, verifier selection, mode flags, chain IDs, token ordering, route authentication, CREATE2 hook flags, manifests and generated ABIs. **Done:** a reproducible deployment rejects incompatible settings and has a reviewed authority map; unchecked/mock admission cannot be mistaken for enforced admission.
- [ ] **SEC-20 — Build identity and deployability (P0; Kritarth; #40/#59/#64).** Measure deployed runtime sizes under the exact compiler profiles and optimizer settings for the combined enforced contract. Recheck dependencies, license-preserving patches, artifact selection and clean-clone builds. **Done:** CI enforces EIP-170 and artifact identities, and optimizer changes have relevant behavioral/gas checks. Passing tests with relaxed size limits is insufficient.

### Separately gated components

- [ ] **SEC-21 — Court evidence and coverage authenticity (P0 before funded Court; Bhoumik + Kritarth review; R9/#11/#21/#27).** Review canonical chain/receipt evidence, anchors and reorgs, pool authentication, router attribution, signature domains, coverage timing, beneficiary binding and unsupported patterns. **Done:** adversarial evidence cannot create an unauthorized payout; detection gaps and the absence of leakage attribution are explicit.
- [ ] **SEC-22 — Court payout conservation and incentives (P0 before funded Court; Bhoumik; R8/#20/#32).** Revalidate the existing self-claim caps and incident accounting, shared victims, reused legs, unbonding and collection boundaries. Investigate the documented LP/JIT fee-recovery exception and ETH/WETH valuation scope. **Done:** distinguish the previously fixed uncapped-drain case from remaining coalition economics; show conservation and justified coverage limits.
- [ ] **SEC-23 — Court watcher operation (P1 before funded Court; Bhoumik; #22).** Test restart/deduplication, confirmations, anchor availability, proof freshness, retries, claim-window timing and collection reconciliation. **Done:** interrupted operation does not duplicate claims, misreport payout or strand a collectible claim without an actionable status.
- [ ] **SEC-24 — Global auctions and shared vault (P0 before global release; Kritarth + solver/client consumers; #57).** Review token registry/configuration, global proof domains, per-token obligations, multilateral pricing, cycle routes and donation isolation. **Done:** independent multi-token invariants and real-proof service tests establish that pair-auction assumptions have not been carried across incorrectly.
- [ ] **SEC-25 — Aqua and auxiliary infrastructure (P2; Kritarth + Khush + Bhoumik; #25/#26).** Define the actual token-moving Aqua flow, callback permissions and accounting; review indexer data validation and outage behavior. **Done:** the configured integration has an end-to-end test, and auxiliary storage cannot determine authoritative balances or require publication of private witnesses. An opcode-only demo does not close this task.

## Work sequence and completion evidence

1. Finish SEC-01 before interpreting the economic scope of E1. Evaluate SEC-02 alongside it; do not promote the experimental wrapper to a protocol guarantee.
2. Run SEC-03 through SEC-07 on the selected execution paths. In parallel, review SEC-08 through SEC-13 and SEC-19/20 before a real-funds deployment.
3. Complete the relevant service/recovery tasks on the integrated build, including independent operation and transaction finality.
4. Gate Court, global auctions and Aqua independently. Their inclusion requires their own evidence, not inheritance of pair-auction results.
5. Obtain independent review against a fixed release candidate and reconcile marketing, UI and documentation claims with the resulting evidence.

Each completed task must attach:

- Exact source commit, clean/dirty status, dependency/toolchain versions and deployment mode.
- Relevant pool/chain configuration and fork block, or explicit offline model assumptions.
- Reproduction/test command, expected behavior, actual outcome and both positive and negative controls.
- Financial units and all included/excluded costs; distinguish realized balances from marked inventory.
- For proposed fixes, before/after evidence using identical starting states, plus liveness and compatibility effects.
- Remaining uncertainty and a disposition: fixed, disproven, constrained by an explicit assumption, or awaiting an owner decision. Research completion is not remediation completion.

Do not count inherited test executions as independent scenarios. A finite search cannot establish absence of an economic attack. A failed search cannot establish infeasibility. Recheck the final combined build rather than crediting checks from an earlier branch or different proof mode.

## Reportability and severity context

Report reachable violations of custody, admission soundness, confidentiality assumptions, payout correctness, authorization, or bounded recovery. Economic findings should identify the affected role, capital/control assumptions, observable loss and tested baseline. Availability and privacy failures remain reportable without direct token theft.

Prioritize potential loss or permanent freezing of funds and admission/coverage forgery above bounded delay or optional-service failure, but assess actual reachability and deployment exposure before assigning severity. Passing a user minimum does not automatically make adverse execution irrelevant; neither does a gross simulated profit automatically demonstrate a profitable live strategy.

No new risk acceptance or suppression is authorized by this document. Known issues remain reportable with their current status; avoid duplicating already-fixed historical cases as new findings. No internet-facing service, deployed balance or production configuration is assumed verified here.

## Research boundaries and handling

Use owned local deployments, isolated forks and offline fixtures for reproduction. Reading public chain state is not permission to send transactions to third-party deployments. Do not use real user keys or expose private witnesses, credentials or unnecessary exploit detail in reports.

Dependency policies discovered under library/package directories remain local to those components; they do not suppress findings in Blindfold's integration. There are no additional owner-approved component exclusions in this document.

No private reporting contact, bug bounty or response-time commitment has been verified for this repository. Establish those with the maintainers before soliciting external disclosures; do not invent a reporting address or ask reporters to post sensitive details publicly.
