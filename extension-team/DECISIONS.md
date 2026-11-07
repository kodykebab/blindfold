# Decisions

Bhoumik decided D1 to D7, D9 and D10 on 2026-11-06 (design doc open questions 1 to 9); D10 was updated the same day to sole ownership. D8 is a build convention.

| # | Question | Decision | What it means for the build |
| --- | --- | --- | --- |
| D1 | Where do proofs run? | **Decided: native helper** (`packages/prover-helper`) wrapping the Go `local-prover` | No in-browser prover in this build |
| D2 | Which Groth16 parameters? | **Decided: single-machine setup**, for this build and for production | This build uses `local-prover setup-local` parameters (chain 31337), pinned by manifest SHA-256. Whoever runs the production setup could forge proofs, so it must run on a trusted machine and its manifest hash is pinned in the release |
| D3 | How does Court get receipts? | **Decided: a new protected-RPC method** that returns an account's receipts (e.g. `blindfold_getReceipts(address)`) | Court phase only, not in this build (BondRegistry isn't on `main` yet) |
| D4 | How is the helper installed? | **Decided: a dev script** (`packages/prover-helper/install.sh`) | Signed per-OS installers come later, at release |
| D5 | Which chain? | **Decided: local anvil (31337)** using `deployments/blindfold.local.json` and the admission deployment from `check-admission.sh` | Unichain and Court on Base come later |
| D6 | State key | **Decided: passphrase only.** PBKDF2-SHA256 (WebCrypto) to an AES-GCM key; never a wallet-signature key | A forgotten passphrase means restoring from an export |
| D7 | Browsers | **Decided: all Chromium browsers** (Chrome, Chromium, Brave, Edge, Arc where its folder is documented) | The helper installer registers the native host in each browser's NativeMessagingHosts folder. Automated tests use Playwright's Chromium |
| D8 | Extension ID | Fixed with a dev `key` in `manifest.json`: `eaoidifkamkmkbcomcbpldjlhipogdgo` (recorded in `INTERFACES.md`) | The helper's `allowed_origins` and the bridge use it |
| D9 | Bridge origin | **Decided: a static page on a Blindfold https web address** in production (domain to be chosen) | Dev stays `http://localhost:4317`; the page must work as plain static files |
| D10 | Ownership | **Decided: the whole extension is Bhoumik's lane**: `packages/extension`, `packages/prover-helper`, `packages/bridge`, `packages/extension-e2e` | Khush's and Kritarth's code is still theirs: the extension reuses `packages/client` and the `local-prover` without editing them |

## Proposals
Add a line: `agent N: proposal ... (why)`. Bhoumik decides.
- agent 1: proposal: move the Node-free parts of `packages/client/lib.mjs` and `state.mjs` (orderHash, encode/decodePayload, armor/dearmor without Buffer, the recorded drand client, the bigint replacer/reviver, validateState, the merge in importState) into one core module that the CLI and the extension both import (today `packages/extension/src/core.mjs` copies them and its tests check they agree with the client; one copy means a fix lands once)
- agent 2: proposal (Kritarth's lane): `packages/client/test/admission-e2e.test.mjs` line 33 `assert.equal(round, 1000000n)` failed twice in `check-admission.sh` on this shared machine (got 1000001n) after both proofs were generated, so the gate never reaches `admit`. The chain deploy apparently crosses a 3 s drand boundary; derive the expected round from the deployed schedule or pin the deploy timestamps. Real-proof onchain verification is covered meanwhile by the helper's I4 test and the extension's E3
