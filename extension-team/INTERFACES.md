# Interfaces

Owned by agent 3 (QA lead). Agents 1 and 2 propose under "Proposals"; agent 3 merges them into the spec. Every format
here has a test in `packages/extension-e2e` or in the owning package.

## Extension ID
`eaoidifkamkmkbcomcbpldjlhipogdgo` (from the dev public key in `packages/extension/manifest.json` `key`; the private key
was discarded, so the unpacked dev build always gets this ID). Native host `allowed_origins`:
`chrome-extension://eaoidifkamkmkbcomcbpldjlhipogdgo/`. `packages/extension` has a test that recomputes it from the key.

## Extension <-> prover helper (Chrome native messaging)
- Host name: `xyz.blindfold.prover` (proposed). Framing: Chrome native messaging (4-byte little-endian length + UTF-8 JSON).
- Request: `{ "id": string, "cmd": string, ...args }`. Response: `{ "id": string, "ok": true, "result": {...} }` or `{ "id": string, "ok": false, "error": { "code": string, "message": string } }`.
- Commands (to be specified by agents 2 and 3): `hello` (version, parameter manifest hash), `prepare`, `online`, plus anything else needed.
- Limits: host-to-Chrome messages must stay under 1 MB.

## Extension <-> bridge page (externally_connectable) — v1
Implemented in `packages/bridge/public/protocol.mjs` (message handling) and `public/wallet.mjs` (EIP-1193 adapter);
each row below has a test in `packages/bridge/test/protocol.test.mjs` or `test/wallet.test.mjs` (named after the row).

**Connection.** The page at `http://localhost:4317/` (D9; `localhost`, not `127.0.0.1`: `externally_connectable` matches
the host name) calls `chrome.runtime.connect("eaoidifkamkmkbcomcbpldjlhipogdgo", { name: "blindfold-bridge" })`. The
extension accepts a port in `runtime.onConnectExternal` only when `port.name === "blindfold-bridge"` and
`port.sender.origin === "http://localhost:4317"`, and disconnects anything else. If the port drops (service worker
restart, extension reload), the bridge reconnects after 1 s and re-sends `hello`, `wallets` and `wallet`. Every message
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
| `error` | `error: { code: "BAD_REQUEST", message }` | the extension sent something that is not a valid message (no `id` to answer) |

**Extension -> bridge**

| `type` | Fields | Effect |
| --- | --- | --- |
| `connect` | `uuid` or `rdns` | connect that wallet (`eth_requestAccounts`), then send `wallet`. The user can also pick it on the page. Fails with `error` `NO_WALLET` if unknown |
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
Owned by agent 1; listed here once stable.

## Proposals
