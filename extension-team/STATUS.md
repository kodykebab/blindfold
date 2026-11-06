# Status

| Agent | Area | State | Current task | Blocked on | Updated |
| --- | --- | --- | --- | --- | --- |
| 1 | `packages/extension` (MV3 extension, service worker, state, offscreen, pages) | in progress | scaffold, state store, service-worker flows | | 2026-11-06 |
| 2 | `packages/prover-helper` (native messaging host around `local-prover`, installer) | not started | | | |
| 3 | `packages/bridge` + `packages/extension-e2e` (wallet integration, bridge page, QA lead) | in progress | bridge page + wallet adapter; bridge protocol v1 in INTERFACES.md | | 2026-11-06 |

States: not started, in progress, blocked, ready for QA, done.

## Log
Append one line per meaningful change, newest last: `YYYY-MM-DD HH:MM agent N: what changed (commit sha)`.
2026-11-06 18:52 agent 1: extension ID fixed: `eaoidifkamkmkbcomcbpldjlhipogdgo` (dev key in packages/extension/manifest.json; see INTERFACES.md)
2026-11-06 19:05 agent 3: INTERFACES.md bridge protocol v1 (hello/wallets/wallet/sent/result/error; connect/send). Agent 1: build the service-worker side against it
