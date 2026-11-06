# Arkiv schema

The user-facing Arkiv feature for this release is a **public, queryable batch history**.

A batch row is useful after settlement, when someone wants to see what clearing price a batch actually used, how many orders it filled, and which transaction settled it. That is already public on the settlement contract. Arkiv makes the same facts queryable without running our own indexer. It is not a second source of truth.

## Why this feature

Issue S19 (#25) keeps contract state authoritative and Arkiv optional. A history of settled batches fits that rule:

- The fields are the public `Settled` event: batch id, clearing price (`priceX96`), fill count, and the settle transaction hash, plus the configured pair label.
- Private order data is out. The writer rejects ciphertext, salt, owner, commit hash and order bodies.
- With Arkiv off, unconfigured, or failing, the trading page still commits, tracks and withdraws from chain data. The history panel says `history unavailable` instead of blocking the order form.

Other Arkiv entities in the product plan (`blindfold.commitment`, `court.verdict`, `court.rpc`, `court.suspect`) stay in the schema for keepers and the watcher. This release's page feature is `blindfold.batch`.

## Entities

| Entity | Fields written here | Owner | Expires | Notes |
|---|---|---|---|---|
| `blindfold.batch` | `batchId`, `pair`, `clearingPrice`, `orderCount`, `settleTx` | settlement mirror | 30 days | Public only. `clearingPrice` is the onchain `priceX96` integer as a decimal string. `orderCount` is the event's fill count. |
| `blindfold.commitment` | `batchId`, `status`, `commitHash`, `ctRef` | committer | reveal deadline + 1 hour | Not written by this package. `ctRef` is unused until Swarm is in. |
| `court.verdict` | `rpcId`, `pool`, `block`, `refund`, `victimTx` | watcher | 1 year | Not written here. The page reads Court from `BondRegistry` logs when a deployment exists. |
| `court.rpc` | `rpcId`, `bond`, `provenSandwiches` | watcher | refreshed hourly | Not written here. |
| `court.suspect` | `victimTx`, `block`, `pool`, `reason` | watcher | same as a verdict | Near-misses only. No payout. |

Attribute names match [CONTEXT.md](../CONTEXT.md).

## Setup

```bash
source env.sh
npm test --prefix packages/arkiv
```

| Variable | Default | Meaning |
|---|---|---|
| `ARKIV` | `off` | `off` uses an in-memory fake in this process. `testnet` is the Arkiv network. |
| `ARKIV_RPC` | unset | Arkiv endpoint. Required before a testnet write. Read from the repo `.env` by `npm start` in the web app. |
| `ARKIV_KEY` | unset | Arkiv access key. Never put it in the page or in a commit. |

`ARKIV=off` does not read or write the network. `ARKIV=testnet` without both `ARKIV_RPC` and `ARKIV_KEY` is treated as down: `query` throws `history unavailable`. The SDK client is not bundled in this package, so a configured testnet currently reports the same outage instead of sending a partial write. Chain state is unchanged either way.

## Query examples

In-memory round trip, offline:

```bash
ARKIV=off node --input-type=module -e '
import { createArkiv, mirrorSettled, recentBatches } from "./packages/arkiv/index.mjs"
const arkiv = createArkiv()
await mirrorSettled([{ batchId: "7", pair: "TKA/TKB", clearingPrice: "79228162514264337593543950336", orderCount: "2", settleTx: "0x" + "ab".repeat(32) }], arkiv)
console.log(await recentBatches(arkiv))
'
```

From the trading page, `GET http://127.0.0.1:3100/api/history` returns `{ unavailable, batches }`. The browser does not receive `ARKIV_KEY`.

A settled-batch mirror call:

```js
import { createArkiv, mirrorSettled } from '@blindfold/arkiv'

await mirrorSettled([{
  batchId: '7',
  pair: 'TKA/TKB',
  clearingPrice: '79228162514264337593543950336',
  orderCount: '2',
  settleTx: '0x' + 'ab'.repeat(32),
}], createArkiv())
```

Passing `ciphertext`, `order`, `salt`, `owner` or `commitHash` throws before anything is stored.

## How it fits

The settlement contract remains the record of fills, balances and deadlines. Arkiv is a read model for people and for services that were not watching the chain. The trading page reads it for **Recent batches**. Status, commit, track and withdraw do not call Arkiv. If the read fails, those actions keep using the client CLI and the chain.

The Court ledger on the same page is separate. It is hidden until `deployments/court.local.json` (or `COURT_DEPLOYMENT`) exists, and then it reads `Bonded`, `ClaimRegistered` and `Collected` from the local RPC. Those events are not copied into Arkiv by this package.
