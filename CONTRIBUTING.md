# CONTRIBUTING.md

How the three of us (Bhoumik, Kritarth, Khush) work in this repo without stepping on each other. [AGENTS.md](AGENTS.md) has the repo rules (setup, compiler, gotchas); this file has the team rules. Both apply, to people and to coding agents. Lanes, seams and the checklist live in [PLAN.md](PLAN.md).

## The loop
```bash
git switch main && git pull
git switch -c <you>/<topic>          # e.g. kritarth/aqua-leg, bhoumik/bond-registry, khush/keeper
# work in small commits
(cd contracts && forge test)          # plus your lane's check from PLAN.md
git push -u origin HEAD
gh pr create --fill
```
- **Merge your own PR** once `forge test` and your lane check pass, if it only touches your lane's files. A PR that touches a shared file or a seam needs one teammate's 👍 first.
- **Merge with "Create a merge commit" or "Rebase and merge". Never "Squash and merge".** 1inch and Arkiv judge commit history.
- Keep branches short-lived (hours, not a day). Pull `main` every couple of hours and rebase before merging.
- Never force-push or rewrite `main`.

## Ownership
- Edit only your lane's files ([PLAN.md](PLAN.md#team-and-lanes)). If you need a change in someone else's lane, ask them, or open a PR and let them merge it.
- Shared files: small, separate PRs, and say so in the chat.
- `PLAN.md`: tick only your own boxes, so merges stay trivial.

## Seams
- A seam is anything another lane reads: ABIs, events, `deployments/*.local.json` keys, Arkiv entity attributes, env vars, ports, anvil account roles.
- Change seams additively (new key, new event, new optional attribute). If a break is unavoidable: tell the consumers, update PLAN.md "Seams" in the same PR, and fix or hand off every consumer.
- Never hardcode deployed addresses or hand-copy ABIs. Read `deployments/*.local.json` and `contracts/out/` (run `forge build` first).
- Everything you build runs alone: fixtures, `ARKIV=off`, seed data. If a teammate can't run your piece without you, that's a bug.

## Solidity
- Follow AGENTS.md "Compiler setup": no `transient` keyword, files that import swap-vm go under `swapvm/` dirs.
- Match the existing style: custom errors, an event for anything a keeper, indexer or UI needs, `@notice` NatSpec on external functions.
- Every feature gets a test. Offline tests never touch the network. Fork tests go in their own contract that overrides the setup, like `BlindfoldUnichainForkTest`.
- Run `forge fmt` only on the files you touched, never on the whole tree.

## JavaScript
- Follow `packages/court-watcher`: ESM `.mjs`, `viem`, exact versions in `package.json`, one `package.json` per package, `package-lock.json` committed.
- Every package has `npm start` (its service or CLI) and `npm test` (`node --test`, built in, no test framework). Test the logic that can break (price search, encoding, decrypt, claim building), not the plumbing.
- Configure through env vars with local defaults, for example `RPC_URL` defaulting to `http://127.0.0.1:8545`. Document new vars in PLAN.md "Seams".
- `app/` can be Next.js + TypeScript. It reads from `packages/arkiv` and the deployments files, not from other packages' internals.

## Keys and secrets
- Locally, use anvil's default accounts in the roles PLAN.md assigns. They're public test keys: fine on anvil, never on a real chain.
- Real keys (the Arkiv wallet, a Base deployer) go in `.env` (gitignored). Never in code, commits, PR text or chat.

## Commits
- Small and often. The message says what changed and why, starting with the area like the existing history: `Court: ...`, `court-watcher: ...`, `Blindfold: ...`, `app: ...`.
- If an agent wrote the change, end the message with a `Co-Authored-By:` line.

## Working with coding agents
- Tell your agent your name and lane, and paste the PLAN.md item you're on. `CLAUDE.md` loads AGENTS.md for Claude Code; other agents read AGENTS.md directly.
- The agent must not edit outside your lane or change a seam without you.
- Read the diff and run the checks before you commit. Don't commit code you haven't run.

## Talking
- Stuck for more than 30 minutes? Say so in the chat. Someone pairs with you, or we fake the piece and move on.
- At each phase end, run the 15-minute sync from PLAN.md: merge, run the exit check, tick boxes, re-split leftovers.
- Known limitations and open questions stay out of the repo (AGENTS.md): put them in `.workspace.md` (gitignored) or the chat.
