# Interfaces

Owned by agent 3 (QA lead). Agents 1 and 2 propose under "Proposals"; agent 3 merges them into the spec. Every format
here has a test in `packages/extension-e2e` or in the owning package:

| Section | Unit tests | End to end (`packages/extension-e2e`, `npm run e2e`) |
| --- | --- | --- |
| Extension ID | `packages/extension` manifest test | `interfaces.test.mjs` (offline: key -> ID = this file = bridge `config.mjs`) |
| Prover helper | `packages/prover-helper/main_test.go`, `packages/extension/test` helper client | `helper.e2e.test.mjs` (real native messaging, stub prover: manifest, `hello`, error codes); `prepare`/`online` with real proofs: E3, not yet run |
| Bridge | `packages/bridge/test/protocol.test.mjs` (one test per row), `wallet.test.mjs`; `packages/extension/test/bridge.test.mjs` | `bridge.e2e.test.mjs`, `origin.e2e.test.mjs`, `extension.e2e.test.mjs` |
| Pages <-> service worker | `packages/extension/test` | `extension.e2e.test.mjs` drives `session`, `setup`, `unlock`, `lock`, `config`, `connect` and the `status`, `track`, `blockers`, `preflight`, `commit`, `deposit`, `cleanup`, `withdraw`, `export` jobs |

## Extension ID
`eaoidifkamkmkbcomcbpldjlhipogdgo` (from the dev public key in `packages/extension/manifest.json` `key`; the private key
was discarded, so the unpacked dev build always gets this ID). Native host `allowed_origins`:
`chrome-extension://eaoidifkamkmkbcomcbpldjlhipogdgo/`. `packages/extension` has a test that recomputes it from the key.

## Extension <-> prover helper (Chrome native messaging) — v1
Implemented in `packages/prover-helper/main.go` (tests: `main_test.go`); the extension's client is
`packages/extension/src/helper.mjs`. `packages/extension-e2e` runs `hello` against the installed helper.

- **Host.** Name `xyz.blindfold.prover`; host manifest `allowed_origins: ["chrome-extension://eaoidifkamkmkbcomcbpldjlhipogdgo/"]`
  only. The helper also checks the caller origin Chrome passes as its first argument (`E_ORIGIN`). `install.sh` writes
  the manifest and a `config.json` next to the binary: `{ extensionId, prover, params, manifestSha256 }` (absolute installed paths). Runtime assets
  are copied into the installation directory; the host does not read the source checkout.
- **Framing.** Chrome native messaging: 4-byte little-endian length, then UTF-8 JSON. At most 1 MB each way, requests
  included (`E_TOO_LARGE`).
- **Envelope.** Request `{ "id": string, "cmd": string, ... }`. Response `{ "id", "ok": true, "result": {...} }` or
  `{ "id", "ok": false, "error": { "code": string, "message": string } }`. A frame that is not JSON gets `id: null`.
- **One port per order.** The extension opens a port, sends `prepare`, then `online` with the returned `session` on the
  **same port**, then disconnects. The helper keeps the witness in memory only: a disconnect (which also stops a running
  proof) or a new `prepare` discards it, and `online` then fails with `E_SESSION`.

| `cmd` | Request fields | `result` |
| --- | --- | --- |
| `hello` | none | `{ protocol: 1, version, chainId: "31337", developmentOnly: true, manifestSha256, proverSha256 }`. The extension refuses to prove unless `manifestSha256` equals its deployment's `admission.manifestSha256` |
| `prepare` | `protocol: 1`, `manifestSha256`, `request`: the `local-prover fixture-local` request exactly as `packages/client/admission.mjs` builds it: `{ chainId, settlement, owner, batch, round, step, totals: [t0, t1], budgets: [b0, b1], oldBlind, zeroForOne, amount, minimum, salt }` (integers as decimal strings) | `{ session, orderHash, oldRoot, newRoot, ciphertextHash, ciphertext, newBlind, preparation: { seal, journal } }` (all `0x` hex). The extension checks `orderHash`, `oldRoot` and `newRoot` against its own computation, as `admission.mjs` does, before using anything |
| `online` | `protocol: 1`, `session` | `{ online: { seal, journal } }`. The `admit` proof argument is `abi.encode(bytes, bytes, bytes, bytes)` of preparation seal, preparation journal, online seal, online journal |

**Error codes.** `E_ORIGIN` (caller is not the extension), `E_CONFIG` (not installed or config invalid: re-run
`install.sh`), `E_TOO_LARGE`, `E_BAD_REQUEST` (not JSON, unknown `cmd`), `E_VERSION` (`protocol` is not 1), `E_PARAMS`
(manifest differs from the pinned one, or parameter files changed), `E_CHAIN` (development parameters: chain 31337
only), `E_SESSION` (no matching `prepare` on this port), `E_PROVER` (local-prover failed; for `prepare` the message
may carry its validation error, never witness values), `E_TIMEOUT` (1 min fixture, 10 min proof; extension transport deadlines: 15 s hello, 12 min prepare, 11 min online), `E_CANCELLED`
(helper shutting down), `E_INTERNAL`.

**Privacy.** The order, salt and blinding cross this port because the proof needs them; they stay on the machine. The
helper writes the witness only to a 0700 temp directory that is removed when the prover exits, captures all child
output, and logs nothing.

## Extension <-> bridge page (externally_connectable) — v1
Implemented in `packages/bridge/public/protocol.mjs` (message handling) and `public/wallet.mjs` (EIP-1193 adapter);
each row below has a test in `packages/bridge/test/protocol.test.mjs` or `test/wallet.test.mjs` (named after the row).

**Origins (D9).** The bridge is plain static files (`packages/bridge/public/`); its only deploy-time value is the
extension ID in `public/config.mjs`. The extension owns the bridge origin: its `externally_connectable` match and its
`port.sender.origin` check must both come from one build-time setting (dev `http://localhost:4317`), so the production
https origin is swapped in by the extension build.

**Connection.** The page at `http://localhost:4317/` (D9; `localhost`, not `127.0.0.1`: `externally_connectable` matches
the host name) calls `chrome.runtime.connect("eaoidifkamkmkbcomcbpldjlhipogdgo", { name: "blindfold-bridge" })`. The
extension accepts a port in `runtime.onConnectExternal` only when `port.name === "blindfold-bridge"` and
`port.sender.origin === "http://localhost:4317"`, and disconnects anything else. If the port drops (service worker
restart, extension reload), the bridge reconnects after 1 s and re-sends `hello`, `wallets` and `wallet`, then any
`sent` / `result` it produced while disconnected (so the extension must accept a `result` for a request id it persisted). Every message
is a JSON object with a `type`. Addresses and hex data are `0x` strings; quantities (`chainId`, `value`) are hex
quantities as in JSON-RPC (`"0x7a69"`).

**Bridge -> extension**

| `type` | Fields | Sent |
| --- | --- | --- |
| `hello` | `version: 1` | after every (re)connect |
| `wallets` | `wallets: [{ uuid, name, icon, rdns }]` | after `hello`, and whenever a wallet announces. EIP-6963 `info`; a legacy `window.ethereum` with no announcement appears as `{ uuid: "injected", rdns: "injected", name: "Browser wallet", icon: "" }` |
| `wallet` | `uuid, name, rdns, accounts: string[], chainId, atomic: boolean` | after a wallet connects, after `accountsChanged` / `chainChanged`, on disconnect (`accounts: []`), and after `hello` if one is selected. `accounts[0]` is the signing account. `atomic`: the wallet reports EIP-5792 atomic batching for `accounts[0]` on `chainId` |
| `sent` | `id, index, hash` | the wallet accepted call `index` of request `id` (sequential path); persist `hash` before it is mined (F2) |
| `sent` | `id, callsId` | the wallet accepted the whole batch (atomic path) |
| `result` | `id, ok: true, atomic: boolean, hashes: string[], receipts: object[]` | every call mined with status `0x1`. Receipts are the wallet's JSON-RPC receipts, unmodified |
| `result` | `id, ok: false, error: { code, message }, hashes, receipts` | the request failed; `hashes` / `receipts` hold whatever was sent or mined before the failure |
| `error` | `error: { code, message }` | a message with no `id` to answer failed: `BAD_REQUEST` (not a valid message), `NO_WALLET` (`connect` to an unknown wallet), or the wallet's code when `connect` fails (`4001` rejected) |
| `ping` | none | every 25 s while connected: keeps the service worker alive while a wallet prompt is open. Ignore it |

**Extension -> bridge**

| `type` | Fields | Effect |
| --- | --- | --- |
| `connect` | `uuid` or `rdns` | connect that wallet (`eth_requestAccounts`), then send `wallet`. The user can also pick it on the page. Fails with `error` `NO_WALLET` if unknown |
| `replaced` | none | sent to the old port just before disconnecting it, when another bridge tab connects (the newest tab wins). That tab stops reconnecting and tells the user; without it two tabs take the port from each other every second |
| `send` | `id` (1–64 chars), `from`, `chain: { chainId, chainName, rpcUrls, nativeCurrency: { name, symbol, decimals } }`, `calls: [{ to, data, value? }]` (1–8 calls, `data` at most 128 KiB each) | sign and send with the selected wallet; answered by `sent`* then exactly one `result` |

**`send`, in order.**
1. One request at a time: a second `send` while one runs gets `result` `BUSY`. No wallet connected: `NO_WALLET`.
2. `from` must equal the wallet's `accounts[0]` (case-insensitive), else `WRONG_ACCOUNT`: private state is per account.
3. Chain: if the wallet's `eth_chainId` differs from `chain.chainId`, `wallet_switchEthereumChain`; on `4902`,
   `wallet_addEthereumChain(chain)`; then `eth_chainId` again, still different: `WRONG_CHAIN`. Nothing is signed before
   this passes. Every transaction also carries `chainId`, so a wallet that switches chains mid-request refuses instead of
   signing on the wrong chain.
4. Atomic path, when `atomic` and more than one call: `wallet_sendCalls` `{ version: "2.0.0", chainId, from,
   atomicRequired: true, calls }`, then `wallet_getCallsStatus` until final (`status >= 200`, or v1 `"CONFIRMED"`).
   If the wallet answers `4200`, `-32601`, `5700`, `5710`, `5740`, `5750` or `5760` (it cannot batch), the bridge falls
   back to the sequential path; nothing was sent.
5. Sequential path: `eth_sendTransaction({ from, to, data, value, chainId })` per call, waiting for each receipt before
   sending the next (a `deposit` must see its `approve`). A receipt with status `0x0` stops with `REVERTED`.

**Error codes.** A wallet error keeps its EIP-1193 / JSON-RPC numeric `code` (`4001` user rejected, `4100`
unauthorized, `4902` unknown chain, `-32603` internal, ...). Bridge codes are strings: `BAD_REQUEST`, `BUSY`,
`NO_WALLET`, `WRONG_ACCOUNT`, `WRONG_CHAIN`, `REVERTED`, `TIMEOUT` (no receipt within 10 minutes; `hashes` still say
what was sent).

**What the bridge never does.** It never calls `personal_sign`, `eth_sign` or `eth_signTypedData*`, never sees an order,
salt, witness or passphrase (only calldata about to go onchain), and keeps nothing in storage. The extension, not the
bridge, checks that every call targets the deployment's vault, settlement or tokens and that `chain.chainId` is the
deployment's chain, before it sends `send` (S5).

## Pages <-> service worker
Owned by agent 1. Implemented in `packages/extension/src/sw.mjs` (worker) and `src/app.mjs` (page). Extension pages use
`chrome.runtime.sendMessage`; the worker ignores other senders and anything with `target: "offscreen"`. Bigints in
results are strings like `"123n"`, the CLI's export format.

**Calls**, answered directly: `{ type: "call", op, args }` -> `{ ok: true, result }` or `{ ok: false, error: string }`.

| `op` | `args` | `result` |
| --- | --- | --- |
| `session` | none | `{ hasPassphrase, unlocked, bridge, bridgeOrigin, wallet, wallets, clock, config }` (`wallet`/`wallets`: the bridge's last messages) |
| `setup` | `{ passphrase }` | `{ unlocked: true }`; first run only, else `a passphrase is already set` |
| `unlock` | `{ passphrase }` | `{ unlocked: true }`, or `error: "wrong passphrase"` |
| `lock` | none | `{ unlocked: false }` |
| `config` | `{ rpcUrl, deployment, drand }` | `{ saved: true }`. `deployment`: a `deployments/*.local.json` object (needs `chainId`, `vault`, `settlement`; `admission.manifestSha256` selects `AdmittedSettlement`). `drand`: recorded rounds `{ public_key, chain_hash, rounds }` (local mode) or `null` for live quicknet |
| `connect` | `{ uuid }` or `{ rdns }` | `{ requested: true }`; forwards bridge `connect` |

**Jobs**, the flows: `{ type: "run", op, args }` -> `{ ok: true, result: { job } }` at once. The worker writes
`job:<job>` to `chrome.storage.session` as `{ op, state: "running" | "done" | "failed", log: string[], result?, error? }`
(`log` grows while it runs, e.g. `sign admit in your wallet`); the page removes the record once it has read it. Jobs need
a wallet account from the bridge; `commit`, `resume`, `cleanup`, `blockers`, `export` and `import` also need `unlock`.

| `op` | `args` | `result` |
| --- | --- | --- |
| `status` | none | balances per token, open commitments, batch, deadlines |
| `track` | none | `[{ id, batchId, state, order, got? }]` (states as the CLI's `track`) |
| `blockers` | none | `[{ id, batchId, state, action, wait?, at?, why }]` |
| `preflight` | `{ side: "sell" \| "buy", amountIn, minOut }` (decimal token units) | `{ ok, problems, order, costs, funding, deadlines }`; sends nothing |
| `commit` | same as `preflight` | preflight result plus `{ committed, round, tx }` or, with admission, `{ admitted, tx }` |
| `resume` | none | `{ resumed }` or `{ admitted, tx }` (the CLI's `resume-admission`) |
| `deposit` | `{ token: "token0" \| "token1", amount }` | `{ deposited }` |
| `cleanup` | `{ dryRun }` | `{ steps, stillOpen }` |
| `withdraw` | `{ token, amount }` (`"all"` allowed) | `{ withdrew }` |
| `export` | none | the state JSON text (same format as the CLI's `export-state`) |
| `import` | `{ text }` | `{ imported, saved }`; refused unless every entry hashes right and matches the chain |

Unread `export` records are removed on worker restart, on lock and by a one-minute cleanup alarm. A page waiting
on a removed result reports that it expired and can be requested again.

Mutating jobs (`deposit`, `commit`, `resume`, `cleanup`, `withdraw`, `import`) take a Web Lock per account and fail
fast with `another operation is running for this account` if it is held.

**Clock.** After each job, on `wallet` messages and on `chrome.alarms` (`tick`, set for the next deadline of an open
commitment) the worker writes `clock: { now, open, due: [{ id, action }], next }` to `chrome.storage.session` and puts
the number of due steps on the action badge.

**Offscreen document.** Worker -> `offscreen.html`: `{ target: "offscreen", op: "encrypt", round, payload, drand }` ->
`{ ok, result: ciphertextHex }`; `{ target: "offscreen", op: "check", ciphertext, round, payload, drand }` ->
`{ ok, result: { round, decrypted } }` (one tlock stanza for quicknet and `round`; decrypted and compared to `payload`
when the round's signature is available).

## Proposals
