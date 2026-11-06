// Was this tx / address sandwiched on Ethereum mainnet, and what did it cost?
// Tx hashes: our own detector (court-watcher), RPC only. Addresses: recent txs from Etherscan (or Dune's dex.sandwiched), then our detector per tx.
import { readFileSync } from 'node:fs'
import { rpc, ETH_RPC, getBlock, getReceipts, swapLogs, findSandwiches, HISTORY_WINDOW, V3_SWAP, V4_SWAP } from '../../packages/court-watcher/lib.mjs'

const DUNE = 'https://api.dune.com/api/v1'
const ETHERSCAN = 'https://api.etherscan.io/v2/api'
const SCAN_TXS = 40 // recent txs per address whose receipts we fetch
const LLAMA = 'https://coins.llama.fi/prices/historical'
const MAX_ENRICH = 10 // per-address cap on receipt downloads
const LIMIT = 6 // parallel RPC jobs; public RPCs return empty bodies when bursted

const TTL = 5 * 60_000
const cache = new Map() // shortcut: in-memory and unbounded; fine for a demo server, use an LRU if this goes public

/** One JSON-RPC batch request, results in input order. Items the batch drops or fails get retried one by one. */
export async function rpcBatch(method, paramsList) {
  const out = new Array(paramsList.length).fill(null)
  if (!paramsList.length) return out
  try {
    const res = await fetch(ETH_RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(paramsList.map((params, id) => ({ jsonrpc: '2.0', id, method, params }))),
    })
    const arr = await res.json()
    if (Array.isArray(arr)) for (const r of arr) if (r.result != null && Number.isInteger(r.id) && r.id < out.length) out[r.id] = r.result
  } catch {}
  const missing = out.flatMap((r, i) => (r === null ? [i] : []))
  const again = await mapLimit(missing, LIMIT, (i) => rpc(ETH_RPC, method, paramsList[i]))
  missing.forEach((i, k) => { out[i] = again[k] })
  return out
}

/** Map with at most `n` jobs in flight; a failed job yields null. */
export async function mapLimit(items, n, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]).catch(() => null) } }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

export const FIXTURES = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url)))

export function classify(q) {
  const s = String(q || '').trim().toLowerCase()
  if (/^0x[0-9a-f]{64}$/.test(s)) return { kind: 'tx', value: s }
  if (/^0x[0-9a-f]{40}$/.test(s)) return { kind: 'address', value: s }
  return { kind: 'invalid', value: s }
}

/** Every sandwich in `swaps` where a swap of tx `txIndex` is a victim. findSandwiches keeps only the first victim, so re-check each pair. */
export function matchVictim(swaps, txIndex) {
  const mine = swaps.filter((s) => s.txIndex === txIndex)
  const out = []
  for (const sw of findSandwiches(swaps)) {
    const { front: f, back: b, profitInToken0: z } = sw
    const v = mine.find((v) => v.pool === f.pool && v.poolId === f.poolId && v.txIndex > f.txIndex && v.txIndex < b.txIndex
      && (v.a0 > 0n) === z && v.from !== f.from) // any route: a router shared with the attacker is not the trader (S5)
    if (v) out.push({ ...sw, victim: v })
  }
  return out
}

async function token(sw) {
  if (sw.front.v4) return null // shortcut: v4 poolId doesn't reveal currencies without an Initialize log lookup; show raw units
  const sel = sw.profitInToken0 ? '0x0dfe1681' : '0xd21220a7' // token0() / token1()
  const r = await rpc(ETH_RPC, 'eth_call', [{ to: sw.front.pool, data: sel }, 'latest'])
  return '0x' + r.slice(26)
}

async function price(addr, ts) {
  try {
    const key = `ethereum:${addr}`
    const j = await (await fetch(`${LLAMA}/${ts}/${key}`)).json()
    return j.coins?.[key] ?? null
  } catch { return null }
}

export async function checkTx(hash, rc) {
  rc ??= await rpc(ETH_RPC, 'eth_getTransactionReceipt', [hash])
  if (!rc) return { kind: 'tx', input: hash, error: 'tx not found on Ethereum mainnet' }
  const n = BigInt(rc.blockNumber)
  const [receipts, block, head] = await Promise.all([getReceipts(n), getBlock(n), rpc(ETH_RPC, 'eth_blockNumber')])
  const ts = Number(block.timestamp)
  const txAt = (i) => receipts.find((r) => Number(r.transactionIndex) === i)?.transactionHash ?? null
  const sandwiches = await Promise.all(matchVictim(swapLogs(receipts), Number(rc.transactionIndex)).map(async (sw) => {
    const tok = await token(sw).catch(() => null)
    const p = tok && await price(tok, ts)
    const amount = p ? Number(sw.profit) / 10 ** p.decimals : null
    return {
      block: Number(n), time: ts, v4: sw.front.v4, pool: sw.front.pool, poolId: sw.front.poolId,
      attacker: sw.front.from, frontTx: txAt(sw.front.txIndex), backTx: txAt(sw.back.txIndex),
      profitRaw: sw.profit.toString(), token: tok, symbol: p?.symbol ?? null, amount, usd: amount !== null ? amount * p.price : null,
      courtProvable: BigInt(head) - n <= HISTORY_WINDOW, // L1 anchor window, AGENTS.md gotcha 7
    }
  }))
  return summarize({ kind: 'tx', input: hash, txs: [{ txHash: hash, block: Number(n), sandwiches }] })
}

function summarize(r) {
  const all = r.txs.flatMap((t) => t.sandwiches)
  r.sandwichCount = all.length
  r.lostUsd = all.reduce((a, s) => a + (s.usd ?? 0), 0)
  r.unpriced = all.filter((s) => s.usd === null).length
  return r
}

async function dune(path, init = {}) {
  const res = await fetch(DUNE + path, { ...init, headers: { 'content-type': 'application/json', 'x-dune-api-key': process.env.DUNE_API_KEY } })
  const j = await res.json()
  if (!res.ok || j.error) throw new Error(`dune ${path}: ${JSON.stringify(j.error ?? j)}`)
  return j
}

export function duneSql(addr) {
  if (classify(addr).kind !== 'address') throw new Error('bad address') // interpolated into SQL: validate here, not only at the caller
  return `select tx_hash, block_number, block_time, project, version, token_pair, amount_usd
from dex.sandwiched where blockchain = 'ethereum' and tx_from = ${addr}
order by block_time desc limit 50`
}

async function duneRows(addr) {
  const { execution_id: id } = await dune('/sql/execute', { method: 'POST', body: JSON.stringify({ sql: duneSql(addr) }) })
  for (let t = 0; t < 60; t++) {
    const s = await dune(`/execution/${id}/status`)
    if (s.state === 'QUERY_STATE_COMPLETED') return (await dune(`/execution/${id}/results`)).result.rows
    if (s.is_execution_finished) throw new Error(`dune query ${s.state}`)
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error('dune query timed out')
}

/** Successful txs the address sent itself: the only ones where it can be the sandwich victim. */
export const ownTxs = (list, addr) => list.filter((t) => t.from?.toLowerCase() === addr && t.isError === '0' && t.txreceipt_status !== '0')
export const hasSwap = (rc) => rc.logs.some((l) => l.topics[0] === V3_SWAP || l.topics[0] === V4_SWAP)

async function etherscanTxs(addr) {
  const u = `${ETHERSCAN}?chainid=1&module=account&action=txlist&address=${addr}&sort=desc&page=1&offset=100&apikey=${process.env.ETHERSCAN_API_KEY}`
  let j
  for (let t = 0; ; t++) {
    try { j = await (await fetch(u)).json(); break } catch (e) { if (t >= 2) throw e; await new Promise((r) => setTimeout(r, 500 * 2 ** t)) }
  }
  if (j.status === '1') return j.result
  if (j.message === 'No transactions found') return []
  throw new Error(`etherscan: ${j.result}`)
}

// shortcut: only the last SCAN_TXS sent txs and MAX_ENRICH swaps, Uniswap v3/v4 only; use Dune for full history
async function checkAddressEtherscan(addr) {
  const txs = ownTxs(await etherscanTxs(addr), addr).slice(0, SCAN_TXS)
  const rcs = await rpcBatch('eth_getTransactionReceipt', txs.map((t) => [t.hash]))
  const swaps = rcs.filter((rc) => rc && hasSwap(rc)).slice(0, MAX_ENRICH)
  const checked = await mapLimit(swaps, LIMIT, (rc) => checkTx(rc.transactionHash, rc))
  const hit = checked.flatMap((c) => c?.txs ?? []).filter((t) => t.sandwiches.length)
  const failed = rcs.filter((rc) => !rc).length + checked.filter((c) => !c).length
  return { ...summarize({ kind: 'address', input: addr, txs: hit }), source: 'etherscan', scannedTxs: txs.length, swapTxs: swaps.length, failed }
}

export async function checkAddress(addr) {
  if (process.env.ETHERSCAN_API_KEY) return checkAddressEtherscan(addr)
  if (!process.env.DUNE_API_KEY) return { kind: 'address', input: addr, error: 'address lookup needs ETHERSCAN_API_KEY or DUNE_API_KEY (or OFFLINE=1 for fixtures)' }
  const rows = [...new Map((await duneRows(addr)).map((r) => [r.tx_hash, r])).values()] // one row per swap; keep one per tx
  const txs = await Promise.all(rows.map(async (r, i) => {
    const base = { txHash: r.tx_hash, block: r.block_number, project: r.project, version: r.version, pair: r.token_pair, tradeUsd: r.amount_usd }
    if (i >= MAX_ENRICH) return { ...base, sandwiches: [] }
    const c = await checkTx(r.tx_hash).catch(() => null)
    return { ...base, sandwiches: c?.txs?.[0]?.sandwiches ?? [] }
  }))
  return { ...summarize({ kind: 'address', input: addr, txs }), duneHits: rows.length }
}

export async function check(q) {
  const { kind, value } = classify(q)
  if (kind === 'invalid') return { kind, input: value, error: 'enter a 0x tx hash (66 chars) or address (42 chars)' }
  if (process.env.OFFLINE === '1') return FIXTURES[value] ? { ...FIXTURES[value], fixture: true } : { kind, input: value, error: 'OFFLINE=1 and no fixture for this input' }
  const hit = cache.get(value)
  if (hit && Date.now() - hit.at < TTL) return { ...hit.r, cached: true }
  const r = await (kind === 'tx' ? checkTx(value) : checkAddress(value))
  if (!r.error && !r.failed) cache.set(value, { at: Date.now(), r })
  return r
}
