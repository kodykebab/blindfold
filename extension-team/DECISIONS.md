# Decisions

Defaults the agents build against until Bhoumik decides otherwise. Each one maps to an open question in the design doc.

| # | Question | Default for this build | Why |
| --- | --- | --- | --- |
| D1 | Where do proofs run? | Native helper (`packages/prover-helper`) wrapping the Go `local-prover`; no in-browser prover yet | Proofs are large; #60 measures before any browser prover |
| D2 | Which Groth16 parameters? | Development parameters from `local-prover setup-local` (chain 31337), pinned by their manifest SHA-256 | Production parameters are #61 |
| D3 | How does Court get receipts? | Out of scope for this build (Court phase 5 needs BondRegistry, not on `main` yet) | Keep the MVP to the auction |
| D4 | How is the helper installed? | `packages/prover-helper/install.sh` registers the native host for Chrome and Chromium (macOS, Linux), dev only | Signed installers come at release |
| D5 | Which chain? | Local anvil (31337) using `deployments/blindfold.local.json` and the admission deployment from `check-admission.sh` | Matches the existing real-proof gate |
| D6 | State key | Passphrase only: PBKDF2-SHA256 (WebCrypto) to an AES-GCM key; no wallet-signature keys | Phishing-safe and simple |
| D7 | Browsers | Chrome-family; automated tests use Playwright's Chromium (branded Chrome won't load unpacked extensions from the command line) | Testable in CI |
| D8 | Extension ID | Fixed with a dev `key` in `manifest.json`; the ID is recorded in `INTERFACES.md` | The helper's `allowed_origins` and the bridge need a stable ID |
| D9 | Bridge origin | Dev: `http://localhost:4317` served from `packages/bridge`; production: a Blindfold https origin (to decide) | `externally_connectable` needs a fixed origin |

## Proposals
Add a line: `agent N: proposal ... (why)`. Bhoumik decides.
