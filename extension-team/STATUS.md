# Status

| Agent | Area | State | Current task | Blocked on | Updated |
| --- | --- | --- | --- | --- | --- |
| 1 | `packages/extension` (MV3 extension, service worker, state, offscreen, pages) | ready for QA | all parts built against bridge v1, helper v1 and Pages <-> SW; `npm run build`, `npm test` (40 offline) | E3 (real proofs through the extension) waits on agent 2's `local-prover` build | 2026-11-06 |
| 2 | `packages/prover-helper` (native messaging host around `local-prover`, installer) | in progress | Go host, installer, tests; building `local-prover` (Go 1.27 toolchain + gnark downloading over a slow link) | | 2026-11-06 |
| 3 | `packages/bridge` + `packages/extension-e2e` (wallet integration, bridge page, QA lead) | in progress | e2e: E2, S5, F1/F2 through the real extension; QA review | | 2026-11-06 |

States: not started, in progress, blocked, ready for QA, done.

## Log
Append one line per meaningful change, newest last: `YYYY-MM-DD HH:MM agent N: what changed (commit sha)`.
2026-11-06 18:52 agent 1: extension ID fixed: `eaoidifkamkmkbcomcbpldjlhipogdgo` (dev key in packages/extension/manifest.json; see INTERFACES.md)
2026-11-06 19:05 agent 3: INTERFACES.md bridge protocol v1 (hello/wallets/wallet/sent/result/error; connect/send). Agent 1: build the service-worker side against it
2026-11-06 19:25 agent 3: packages/bridge: static page + dev server, EIP-6963 discovery, EIP-5792 with one-by-one fallback, 25 unit tests. INTERFACES: `ping`, queued results after reconnect, D9 origin note. Agent 1: take the bridge origin (externally_connectable + sender.origin check) from one build setting
2026-11-06 20:05 agent 3: INTERFACES helper section v1 (hello/prepare/online on one port, errors) written from agent 2's main.go; bridge `replaced` message added (extension -> bridge, newest tab wins). Agent 1: send `replaced` before disconnecting an old bridge port (BUGS B1)
2026-11-06 20:05 agent 3: packages/extension-e2e: anvil 8563 deploy (settles at price 1), test wallet, stand-in extension; passing: bridge e2e 10/10, I1+S4 4/4 and I2+E1 2/2 against the real extension
2026-11-06 19:20 agent 1: packages/extension ready for QA (ed97475, 1cba2ae, 731ac2b, 90e029f, f425e13). `npm run build` -> loadable `dist/` (BRIDGE_ORIGIN sets externally_connectable and the sender.origin check, D9); `npm test` 40/40 offline: U1-U5, save-before-send, resume after a crash, send journal for re-delivered `sent`/`result`, bridge, helper, tlock, manifest ID. S5: calls only to the deployment's vault/settlement/tokens, and the deployment's vault must be the settlement's `vault()` and the RPC on its chain (B4). Smoke-tested in Playwright Chromium without a bridge: unlock, config, status, preflight, offscreen tlock encrypt+check, state saved before send. Pages <-> SW spec in INTERFACES.md. Not run yet: admission through the real helper (no `local-prover` binary here yet)
