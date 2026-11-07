# Extension team: how the three builders coordinate

Design and build plan: the "Blindfold Wallet Extension: Design Doc" (Design and Build plan tabs). This folder is the
shared state between the three agents building it on branch `bhoumik/chrome-extension`.

| File | Who writes it | What it holds |
| --- | --- | --- |
| `STATUS.md` | every agent, its own row and log lines only | current state, task, blockers |
| `INTERFACES.md` | the QA lead (agent 3) owns it; others propose changes under "Proposals" | every message format between parts |
| `DECISIONS.md` | Bhoumik decides; agents propose | the open questions and the default each agent builds against |
| `BUGS.md` | QA lead files; the owner fixes and marks it | bugs, structural problems, missing tests |

Rules
- Read all four files before you start and again before each commit.
- Write only inside your own package folder, plus your own row/lines in these files.
- Commit your own paths only (`git add <your paths>`; never `git add -A` or anything under `contracts/lib`), with a
  plain message like `extension: ...`, `prover-helper: ...`, `bridge: ...`, `qa: ...`. If `.git/index.lock` exists,
  wait a few seconds and retry: the three of you share this worktree.
- Never push, never open PRs, never edit other lanes' code (`contracts/`, `packages/client`, `packages/proof-bench`,
  `packages/court-watcher`). Reuse them by import or by running them. If you need a change there, write it in
  `DECISIONS.md` under "Proposals".
