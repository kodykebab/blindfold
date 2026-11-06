# Interfaces

Owned by agent 3 (QA lead). Agents 1 and 2 propose under "Proposals"; agent 3 merges them into the spec. Every format
here has a test in `packages/extension-e2e` or in the owning package.

## Extension ID
TBD (agent 1 fills in once the dev key exists).

## Extension <-> prover helper (Chrome native messaging)
- Host name: `xyz.blindfold.prover` (proposed). Framing: Chrome native messaging (4-byte little-endian length + UTF-8 JSON).
- Request: `{ "id": string, "cmd": string, ...args }`. Response: `{ "id": string, "ok": true, "result": {...} }` or `{ "id": string, "ok": false, "error": { "code": string, "message": string } }`.
- Commands (to be specified by agents 2 and 3): `hello` (version, parameter manifest hash), `prepare`, `online`, plus anything else needed.
- Limits: host-to-Chrome messages must stay under 1 MB.

## Extension <-> bridge page (externally_connectable)
- The bridge page connects with `chrome.runtime.connect(EXTENSION_ID, { name: "blindfold-bridge" })`.
- Messages: to be specified by agents 1 and 3 (wallet discovery result, account/chain changes, transaction requests and results, batch support).

## Pages <-> service worker
Owned by agent 1; listed here once stable.

## Proposals
