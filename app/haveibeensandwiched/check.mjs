// Was this tx / address sandwiched on Ethereum mainnet, and what did it cost?
// Tx hashes: our own detector (court-watcher), RPC only. Addresses: recent txs from Etherscan, then our detector per tx.
import { readFileSync } from 'node:fs'
import { rpc, ETH_RPC, getBlock, getReceipts, swapLogs, findSandwiches, HISTORY_WINDOW, V3_SWAP, V4_SWAP, V4_POOL_MANAGER } from '../../packages/court-watcher/lib.mjs'

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

/**
 * Every sandwich around tx `txIndex`: one bot swaps the victim's pool before it in the same direction, and after it in the other.
 * Looser than Court's predicate, to match what MEV trackers report: a bot's swaps in one tx are netted, and the back-run may
 * unwind only part of the front-run (bots often keep some inventory). `strict` says whether Court's predicate also holds.
 * `profit` is in the token the front-run paid in: what the back-run got back, minus what the front-run paid, plus any
 * inventory the bot kept, valued at the back-run's own price (an outside price feed can be off by more than the profit).
 */
export function matchVictim(swaps, txIndex) {
  const via = (s) => s.caller ?? s.trader // court-watcher calls the pool's caller `trader` before S5 and `caller` after
  const net = new Map() // one leg per (tx, pool, signer, calling contract): a back-run split over several swaps counts once
  for (const s of swaps) {
    const k = `${s.txIndex}|${s.pool}|${s.poolId}|${s.from}|${via(s)}`, l = net.get(k)
    if (l) { l.a0 += s.a0; l.a1 += s.a1 } else net.set(k, { ...s })
  }
  const legs = [...net.values()], strict = findSandwiches(swaps), out = []
  for (const v of legs.filter((l) => l.txIndex === txIndex)) for (const f of legs) {
    // any route: a router shared with the attacker is not the trader (S5), so only the signer tells them apart
    if (f.pool !== v.pool || f.poolId !== v.poolId || f.txIndex >= v.txIndex || f.from === v.from) continue
    const z = f.a0 > 0n
    if ((v.a0 > 0n) !== z) continue
    const b = legs.find((b) => b.pool === f.pool && b.poolId === f.poolId && b.txIndex > v.txIndex && b.from === f.from && via(b) === via(f) && (b.a0 > 0n) !== z)
    const bought = -(z ? f.a1 : f.a0), sold = b ? (z ? b.a1 : b.a0) : 0n
    if (!b || bought <= 0n || sold * 2n < bought) continue // the back-run must unwind at least half of what the front-run bought
    const pay = z ? f.a0 : f.a1, backIn = -(z ? b.a0 : b.a1), kept = -(z ? f.a1 + b.a1 : f.a0 + b.a0)
    const profit = backIn - pay + (kept * backIn) / sold
    const s = strict.some((x) => x.front.txIndex === f.txIndex && x.back.txIndex === b.txIndex && x.front.pool === f.pool && x.front.poolId === f.poolId)
    if (!s && profit <= 0n) continue // a loose match only counts when the bot came out ahead
    out.push({ front: f, victim: v, back: b, profitInToken0: z, profit, kept, strict: s })
  }
  return out
}

// Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24, int24, address, uint160, int24)
const V4_INIT = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438'
const v4Keys = new Map() // poolId -> [currency0, currency1]; a pool's currencies never change

/** A v4 pool's currencies, from its Initialize log. Public RPCs refuse archive getLogs, so this goes through Etherscan. */
async function v4Currencies(poolId) {
  if (v4Keys.has(poolId)) return v4Keys.get(poolId)
  if (!process.env.ETHERSCAN_API_KEY) return null // shortcut: without a key, v4 sandwiches stay in raw units
  const u = `${ETHERSCAN}?chainid=1&module=logs&action=getLogs&address=${V4_POOL_MANAGER}&topic0=${V4_INIT}&topic1=${poolId}&topic0_1_opr=and&fromBlock=0&toBlock=latest&apikey=${process.env.ETHERSCAN_API_KEY}`
  const t = await fetch(u).then((r) => r.json()).then((j) => (j.status === '1' ? j.result[0]?.topics : null)).catch(() => null)
  if (!t) return null
  const key = [t[2], t[3]].map((x) => '0x' + x.slice(26))
  v4Keys.set(poolId, key)
  return key
}

async function token(sw) {
  if (sw.front.v4) return (await v4Currencies(sw.front.poolId))?.[sw.profitInToken0 ? 0 : 1] ?? null
  const sel = sw.profitInToken0 ? '0x0dfe1681' : '0xd21220a7' // token0() / token1()
  const r = await rpc(ETH_RPC, 'eth_call', [{ to: sw.front.pool, data: sel }, 'latest'])
  return '0x' + r.slice(26)
}

const NATIVE = '0x' + '00'.repeat(20), WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
async function price(addr, ts) {
  try {
    const native = addr === NATIVE // v4 pools can hold native ETH (currency 0x0): price it as WETH
    const key = `ethereum:${native ? WETH : addr}`
    const j = await (await fetch(`${LLAMA}/${ts}/${key}`)).json()
    const p = j.coins?.[key] ?? null
    return p && native ? { ...p, symbol: 'ETH' } : p
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
      strict: sw.strict, // false: the bot kept inventory, which Court's predicate doesn't accept
      courtProvable: sw.strict && BigInt(head) - n <= HISTORY_WINDOW, // Court's predicate, within the L1 anchor window (AGENTS.md gotcha 7)
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

// shortcut: only the last SCAN_TXS sent txs and MAX_ENRICH swaps, Uniswap v3/v4 only; page through Etherscan for full history
export async function checkAddress(addr) {
  if (!process.env.ETHERSCAN_API_KEY) return { kind: 'address', input: addr, error: 'address lookup needs ETHERSCAN_API_KEY (or OFFLINE=1 for fixtures)' }
  const txs = ownTxs(await etherscanTxs(addr), addr).slice(0, SCAN_TXS)
  const rcs = await rpcBatch('eth_getTransactionReceipt', txs.map((t) => [t.hash]))
  const swaps = rcs.filter((rc) => rc && hasSwap(rc)).slice(0, MAX_ENRICH)
  const checked = await mapLimit(swaps, LIMIT, (rc) => checkTx(rc.transactionHash, rc))
  const hit = checked.flatMap((c) => c?.txs ?? []).filter((t) => t.sandwiches.length)
  const failed = rcs.filter((rc) => !rc).length + checked.filter((c) => !c).length
  return { ...summarize({ kind: 'address', input: addr, txs: hit }), source: 'etherscan', scannedTxs: txs.length, swapTxs: swaps.length, failed }
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
