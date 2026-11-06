# CLI reference

The client CLI is the only component that holds your key and signs. The trading page runs these same commands for you.

```bash
source env.sh
cd packages/client && npm ci --ignore-scripts      # once
npm start -- <command> [arguments]                 # or: node packages/client/cli.mjs <command> …
```

It reads its settings from the environment ([Configuration](configuration.md)): at least `RPC_URL`, `DEPLOYMENTS` and an account. Before any command it checks that the RPC's chain, and the deployment's vault, pair and deposit token, match the settlement contract; on a mismatch it stops before signing anything.

`sell` means token0 in, token1 out. `buy` means token1 in, token0 out. Amounts are decimal token units (`10`, `0.5`); they're never rounded, and too many decimals is an error.

## Commands

| Command | What it does |
|---|---|
| `status [--json]` | Account, network, pair, balances (wallet, available, reserved, withdrawable), open commitments, the current batch and its deadlines, preparation state, and the quote |
| `deposit <token0\|token1> <amount>` | Approves if needed, then deposits into the vault. Refuses fee-on-transfer or rebasing tokens before sending. |
| `commit <sell\|buy> <amountIn> <minAmountOut> [flags]` | Preview, encrypt, (prove), save locally, commit |
| `prepare-admission <batch-id>` | Builds the preparation proof for a batch ahead of time (admission on) |
| `resume-admission` | Finishes an admission that was interrupted: resends the same proof if it was dropped, or reconciles with the chain |
| `track [--json]` | Every commitment of this account and what happened to it |
| `blockers [--json]` | Which commitments block withdrawal and what clears each |
| `cleanup [--dry-run] [--json]` | One transaction per step: reveal your own saved orders, release or slash unrevealed ones, expire unsettled batches |
| `withdraw <token0\|token1> <amount\|all>` | Withdraws from the vault (blocked while any commitment is open) |
| `export-state <file>` | Backs up your saved orders, salts and funding state (not encrypted) |
| `import-state <file>` | Restores a backup after checking every order against its hash and the chain |

`commit` flags:
- `--dry-run`: preview only, nothing sent.
- `--vault-only`: trade only from vault balances; fail instead of depositing a shortfall.
- `--both-funded`: require both tokens to have a vault balance.
- `--json`: with `--dry-run`, a JSON preview including the quote and a gas estimate.

The trading page always passes `--vault-only --both-funded`.

## JSON output

`--json` prints one JSON object on the last line of output. Amounts are decimal strings in token units; times are unix seconds; big integers are strings.

**`status --json`**
```json
{
  "account": "0x…", "chainId": 31337,
  "pair": { "token0": { "address": "0x…", "symbol": "TKA", "decimals": 18, "role": "token0" }, "token1": { … } },
  "balances": [ { "token": "token0", "wallet": "100", "available": "20", "reserved": "0", "withdrawable": "20" }, … ],
  "openCommitments": 0,
  "batch": { "id": "3", "now": 1700000000, "deadlines": [ { "at": 1700000060, "what": "commits close" }, … ] },
  "preparation": "none",
  "quote": { … pool price, external reference and liquidity, each with its source and block … }
}
```
Token symbols come from the token contract, so they're capped at 32 characters with control characters removed; if `symbol()` fails, the address is used.

**`track --json`**
```json
{
  "policy": { "depositToken": "TKB", "depositAmount": "5.0", "commitFee": "…", "bountyBps": 2000, "admissionRequired": true },
  "now": 1700000000,
  "orders": [ { "id": "0", "batch": "1", "state": "filled", "side": "sell",
    "amountIn": "10.0", "tokenIn": "TKA", "minOut": "9.0", "tokenOut": "TKB",
    "executedIn": "6.0", "received": "5.9", "unusedIn": "4.0", "fill": "partial",
    "schedule": { "revealOpens": …, "revealCloses": …, "settleCloses": … },
    "blocking": false, "commitTx": "0x…" } ]
}
```
- `state` is one of `committed`, `revealed`, `padding`, `unfunded`, `filled`, `unfilled`, `slashed`, `released`, `expired`.
- Before a reveal, the order fields are `null`; if this machine saved the order, they're filled in and `sealedLocally` is `true`.

**`blockers --json`**: `{ "now": n, "steps": [ { "id", "batch", "state", "action", "at", "why" } ] }`, where `action` is `reveal`, `wait`, `slash`, `release` or `expire`, and `at` is when a `wait` ends.

**`cleanup [--dry-run] --json`**: `{ "dryRun": bool, "done": [ { "id", "action", "tx" } ], "stillBlocking": n }`.

## Errors

Errors print one line starting with `client:` and exit with code 1. The trading page turns each into a sentence and a next step.

Some to know:
- **`cannot reach the RPC at <origin>`**: the node is down or `RPC_URL` is wrong. Only the origin is shown, because URLs can carry API keys.
- **`… was dropped before inclusion; it is safe to run the command again`.**
- **`private state is locked by running process N`**: wait for that command. A lock left by an exited process is cleared automatically.
- **`an admission submission is pending; run resume-admission`.**

## Other services

- **Keeper:** `node packages/keeper/keeper.mjs [--once]` prints one JSON status per cycle.
- **Solver:** `node packages/solver/solver.mjs [--once] [--json]`; with `--json`, one status object per cycle.

Both use the same `RPC_URL` and `DEPLOYMENTS` as the client, with their own accounts. See their READMEs: [keeper](../packages/keeper/README.md), [solver](../packages/solver/README.md).

## Local page server API

The trading page's server (`app/haveibeensandwiched/server.mjs`) listens on `127.0.0.1` only:

| Method and path | Purpose |
|---|---|
| `POST /api/trade` | Start one CLI command from a fixed action list (`status`, `deposit`, `withdraw`, `preflight`, `commit`, `prepare-admission`, `resume-admission`, `track`, `blockers`, `cleanup`, `cleanup-preview`, `backup-export`, `backup-import`). Requires the page's own `Origin`, `content-type: application/json` and `x-blindfold-request: 1`. Returns `{ id }`. |
| `GET /api/trade/<id>` | That job's `state` (`running`, `done`, `failed`), `action`, `output` and `startedAt` |
| `GET /api/history` | Recent settled batches from Arkiv, or `{ unavailable: true }` |
| `GET /api/court` | Court bond, claim and payout rows when a Court deployment is configured |
| `GET /api/check?q=` | The "have I been sandwiched" lookup on the landing page |
