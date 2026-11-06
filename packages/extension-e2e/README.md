# Extension end-to-end tests

Drives the real Blindfold extension (`packages/extension/dist`) in Playwright's Chromium (D7), with the bridge page
(`packages/bridge`) on `http://localhost:4317`, a local anvil on port 8563 and a test wallet.

```bash
source ../../env.sh
npm ci
npx playwright install chromium          # once: Playwright's own Chromium (branded Chrome won't load unpacked extensions)
npm test                                 # offline: IDs and origins agree across packages; e2e cases skip
(cd ../extension && npm ci && npm run build)
npm run e2e                              # every case below, one at a time (fixed ports 8563 and 4317)
EXT_E2E=1 node --test test/bridge.e2e.test.mjs   # one file; HEADED=1 shows the browser
npm start                                # manual stack: anvil 8563 + deployment + bridge (C1, C6)
```

The harness builds the contracts (`forge build --no-dynamic-test-linking`) when artifacts are missing or contain
Foundry-only dynamic linking bytecode, holding `extension-team/.forge.lock` while it builds. It refuses an occupied
anvil port before deploying. Each test file starts its own anvil and a fresh browser profile.

**Test wallet.** `lib/anvil-wallet.mjs` injects a small EIP-1193 provider into the bridge origin only (Playwright init
script), announces it with EIP-6963, and signs with anvil account 10's public test key on the Node side. Tests switch
its accounts and chain, toggle EIP-5792 atomic support, reject requests (4001), hold a send, and read its request log
to prove nothing was signed. It exists only in this package and never ships. `lib/fake-extension.mjs` is a stand-in
extension with the same dev key (same ID), used to test the bridge page on its own.

## Cases
| Case | File | What |
| --- | --- | --- |
| harness | `chain.e2e.test.mjs` | the E2 deployment settles a crossing batch at price 1 without the extension |
| bridge | `bridge.e2e.test.mjs` | stand-in extension: discovery, connect, account/chain events, approve+deposit one by one and as an EIP-5792 batch, 4001, wrong chain (switch, 4902 add, refused), wrong account, port drop mid-request, two tabs |
| I1, S4 | `origin.e2e.test.mjs` | only the bridge origin gets `chrome.runtime`; wrong port names are dropped; one-shot messages get no answer; two bridge tabs don't fight (B1) |
| I2, E1, E2, S5, F1, F2, B2, B5 | `extension.e2e.test.mjs` | real extension: wallet list and account/chain changes; deposit and withdraw; one EIP-5792 approve/deposit request; unread exports cleared on lock; commit, reveal, settle at price 1, withdraw, with no plaintext order or salt in `chrome.storage`; wrong chain and wrong vault refused before signing; crash before send keeps the order, crash before inclusion is recovered and revealed |
| helper | `helper.e2e.test.mjs` | real native messaging from the real extension to `prover-helper` installed into the test profile only (`lib/helper.mjs`; HOME is a temp dir, so no real browser is touched), with a stub prover: host manifest, `hello`, error codes |
| IDs | `interfaces.test.mjs` (offline) | extension ID from the manifest key = INTERFACES.md = bridge `config.mjs`; `externally_connectable` is the bridge origin only |
| E3 | `admission.e2e.test.mjs` | real-proof admission: two orders proved by the installed helper and admitted, revealed, settled, withdrawn. Skips until `bash packages/proof-bench/check-admission.sh` has built `local-prover`, its parameters and verifiers; recorded chain time advances one second per mined block, independent of proving latency |

## Verified local build (2026-11-06)

E3 passes with the real prover: two admissions advance cumulative funding to step 2, then reveal, settle at price 1
and withdraw. The admission jobs took 210.9 s and 199.1 s; the completed test reported 414.33 s. See the pinned
program identity and per-mode measurements in [MEASUREMENTS.md](../prover-helper/MEASUREMENTS.md).

## C1: MetaMask, by hand
MetaMask is never downloaded by the harness. With MetaMask installed in Chrome (or Brave/Edge for C6):

1. `npm start` here; build and load `packages/extension/dist` unpacked (`chrome://extensions`, developer mode).
2. In MetaMask, import anvil account 10's private key (public test key; local chain only, never a real one).
3. Open `http://localhost:4317/`. MetaMask appears in the wallet list (EIP-6963), with its icon. Click it and approve
   the connection: the page shows the account, chain and batching mode.
4. In MetaMask switch to another network: the page's chain changes. Start a deposit from the extension: the bridge asks
   MetaMask to switch back; on a fresh MetaMask it asks to add "Blindfold 31337" (`4902` then `wallet_addEthereumChain`).
5. Deposit: on an upgraded (EIP-7702) account MetaMask shows one batch with approve and deposit; otherwise two
   prompts. Both land; the extension shows the vault balance.
6. Reject a prompt: the extension reports "rejected" and nothing is sent.
7. Switch accounts in MetaMask mid-flow: the extension refuses to send for the other account (`WRONG_ACCOUNT`).
8. At no point does MetaMask ask to sign a message.
9. Commit, wait for the reveal, reveal, and withdraw from the extension: each step is one MetaMask prompt.

## C6: Brave and Edge, by hand
Repeat C1 steps 1, 3, 5 and 9 in Brave and in Edge (load unpacked from `brave://extensions` / `edge://extensions`). With
E3, also run `packages/prover-helper/install.sh` and check that the extension reaches the helper in each browser.
