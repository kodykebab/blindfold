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
| `blindfold.batch` | `batchId` (u256), `pair` (str), `clearingPrice` (str), `orderCount` (u256), `settleTx` (str) | settlement mirror | 30 days | Public only. `clearingPrice` is the onchain `priceX96` integer as a decimal string. `orderCount` is how many orders the solver settled. `batchId` is indexed. |
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
| `ARKIV` | `off` | `off` writes a local JSON file. `testnet` uses the Arkiv network. |
| `ARKIV_FILE` | `$CLIENT_STATE/arkiv-local.json` | File used when `ARKIV=off`. The trading page and the solver must share `CLIENT_STATE` (or set the same `ARKIV_FILE`) to see the same rows. |
| `ARKIV_RPC` | unset | Arkiv HTTP endpoint, for example `https://rpc.rabdi.db-chain.testnet.arkiv.network/<access-key>`. Required before a testnet write. |
| `ARKIV_KEY` | unset | Hex private key that signs the write and pays testnet tGLM. Put it only in the repo `.env`. Never print it, never commit it, never send it to the page. |

`ARKIV=off` does not read or write the network. The file is appended on each settled batch and read back oldest first; `recentBatches` reverses that, so the page sees the newest row first. `ARKIV=testnet` without both `ARKIV_RPC` and `ARKIV_KEY`, or with an endpoint that does not answer, throws `history unavailable`. Chain state is unchanged either way.

Testnet entities use `@arkiv-network/sdk` 1.0.1. The schema name is `blindfold.batch`. Columns:

| Column | Arkiv type | Indexed | Value |
|---|---|---|---|
| `batchId` | `u256` | yes | batch id |
| `pair` | `str` | no | `token0/token1` addresses from the deployment |
| `clearingPrice` | `str` | no | onchain `priceX96` as a decimal string |
| `orderCount` | `u256` | no | orders in the settled batch |
| `settleTx` | `str` | no | settlement transaction hash |

A named schema tags each entity with `arkiv.schema = blindfold.batch`, so a query through the schema does not see other projects' rows. Entities expire after 30 days. The SDK cannot sort by `$createdAt`, so the adapter reads that block number and sorts in process: oldest first from `query`, newest first from `recentBatches`.

```js
import { createPublicClient, defineSchema, str, u256 } from '@arkiv-network/sdk'
import { rabdi } from '@arkiv-network/sdk/chains'
import { http } from 'viem'

const Batch = defineSchema('blindfold.batch', {
  batchId: u256().indexed(),
  pair: str(),
  clearingPrice: str(),
  orderCount: u256(),
  settleTx: str(),
})
const client = createPublicClient({ chain: rabdi({ accessKey: '' }), transport: http(process.env.ARKIV_RPC) })
const { entities } = await client.select({
  batchId: true, pair: true, clearingPrice: true, orderCount: true, settleTx: true,
}).from(Batch).fetch()
```

The access key belongs in `ARKIV_RPC` (Rabdi puts it in the URL path). `rabdi({ accessKey: '' })` only supplies the chain id; the transport URL is `ARKIV_RPC`. Do not pass `ARKIV_KEY` as the access key. `ARKIV_KEY` is the writer account. Get tGLM for that account from the Arkiv faucet. Get an access key from hub.arkiv.network/access-keys and keep it inside `ARKIV_RPC` in `.env`.

## Query examples

Local file round trip, offline. A second process with the same `ARKIV_FILE` reads the same rows:

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
