# Trust boundaries and the private witness path

Review of the local trading stack as built on `bhoumik/prover-ui`. Checklist items 2.9 ("webpage/local-service/wallet/prover trust boundary") and 4.11 ("witness/privacy review of the browser-to-helper path"). Every claim below was checked in the code named next to it. Open items are listed at the end.

## What is private

- **Order and salt:** whoever holds them can reveal the order early or link it to the user.
- **The admission witness:** funding state, the order, budgets and the key wrapper, which go into the proofs.
- **Exported backups:** these contain all of the above.
- **Signing keys:** the CLI's key, or the browser wallet's.

## Boundaries

| From → to | What crosses | Controls (file) |
|---|---|---|
| Any website → local page server | HTTP to `127.0.0.1:3100` | Binds `127.0.0.1` only. A `Host` allow-list blocks DNS rebinding. `POST /api/trade` requires `Origin` = the page, `content-type: application/json` and `x-blindfold-request: 1`, so a cross-site form or `fetch` fails the CORS preflight. The page may never be framed: `X-Frame-Options: DENY` and `frame-ancestors 'none'` (**added in this review**). Pages are `nosniff`. (`app/haveibeensandwiched/server.mjs`) |
| Page → local CLI | A fixed action list, never a command string | `command()` maps each action to fixed CLI arguments and validates amounts, sides, tokens and batch ids. Anything else is `Invalid action or arguments`. One job runs at a time. (`trading-server.mjs`) |
| CLI → page | Job output | Output is capped at 32 kB, and the backup temp path is replaced with `[private temporary file]`. A backup is delivered once and then removed from job history. The page renders all output as text, never HTML (no `innerHTML` in the trade page). (`trading-server.mjs`, `trade.mjs`) |
| Chain → page | Token `symbol()` values chosen by a token's deployer | `status --json` caps symbols at 32 characters and strips control characters. The page uses `textContent`. (`packages/client/quote.mjs`, `trade.mjs`) |
| CLI → RPC | Reads and signed transactions | The deployment is checked against the chain before anything is signed: chain id, vault, pair, deposit token. Errors name the RPC by origin only, because URLs often hold API keys; the solver used to log the full URL. (`cli.mjs` `validateDeployment`, `packages/client/rpc-error.mjs`) |
| CLI → local prover | The witness | Sent on stdin, or in a `0700` temp directory with a `0600` file deleted in `finally`. Prover stderr is discarded, never forwarded, because diagnostics can echo witness values. **A prover killed mid-proof used to leave the witness file in `/tmp`.** Stale `blindfold-witness-*` directories older than 30 minutes are now swept before each proof (**added in this review**). (`packages/client/admission.mjs`, `packages/client/sweep.mjs`) |
| Page server → disk | Backup import and export copies | A `0600` file in a private temp directory, removed when the job ends. **A server killed mid-backup left the copy behind.** Stale `blindfold-web-backup-*` directories are now swept the same way (**added in this review**). (`trading-server.mjs`) |
| Extension → native helper | The witness | Native messaging, with the helper manifest's `allowed_origins` limited to the extension's fixed id. The helper keeps the preparation witness in memory, and writes the online witness to a `0700` temp directory that a guard process deletes even if the helper is killed. There's a test for this: `real_test.go` checks no witness files are left. (`packages/prover-helper/install.sh`, `main.go`) |
| Bridge page → extension | Wallet requests and results only | `externally_connectable` is limited to the bridge origin, and only the newest bridge connection is kept. The bridge sees transaction calls, never the witness or order plaintext. (`packages/extension/manifest.json`, `src/bridge.mjs`) |
| Page → browser wallet | Nothing that signs | `wallet-view.mjs` only discovers wallets and reads the account and chain. It never requests a signature. The CLI signs for the page; the wallet signs for the extension through the bridge. |

## Open items (need a decision or other owners)

1. **Private state and exported backups aren't encrypted at rest** (checklist 6.11). The CLI's state directory and `export-state` files are plain JSON (`0600`); only the automatic backup (`backup.mjs`, AES-256-GCM) is encrypted. Anyone with the user's file access can read orders and salts. The extension already encrypts with a passphrase (PBKDF2 to AES-GCM, DECISIONS D6). The CLI needs the same or an OS keychain. *Team decision.*
2. **Job results can be read by any local process.** `GET /api/trade/<id>` has no auth beyond an unguessable UUID and the `Host` check. Output contains the account, balances and order sizes, but no salts or keys. Acceptable on a single-user machine; on a shared machine, add a per-session token.
3. **Single-machine Groth16 parameters** (DECISIONS D2): whoever ran setup can forge proofs. The production setup and its pinned manifest belong to Kritarth (checklist 9.11).
4. **The fee-on-transfer probe needs an RPC with `eth_call` state overrides.** Without them, deposits fail closed with "could not check how much this token delivers". That's safe, but it blocks deposits on such RPCs. (`cli.mjs` `arrivedOnTransfer`)

## Tests for the changes in this review

- `app/haveibeensandwiched/server.test.mjs`: `/trade` carries `X-Frame-Options: DENY` and `frame-ancestors 'none'`.
- `packages/client/test/sweep.test.mjs`: only old directories with our prefix are removed. A live proof's directory and other programs' files are kept.
- `packages/client/test/rpc-error.test.mjs`: an unreachable RPC is named by origin, never with its path or key.
