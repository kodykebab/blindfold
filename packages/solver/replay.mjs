// Replays real Uniswap v3 order flow from Ethereum mainnet through Blindfold's batch rules and reports how often
// orders fill, go unfilled or expire. Read-only: Swap logs only (no archive state, no fork, no keys).
//   source env.sh; node packages/solver/replay.mjs                  # last 24 h, default pools and grid
//   HOURS=6 POOLS=usdc-weth node packages/solver/replay.mjs
//   REPLAY_OUT=packages/solver/benchmarks/replay.json node packages/solver/replay.mjs
// Each real swap becomes an order of the same size and direction, quoted at the pool price just before it (fee
// included) with a slippage limit. Orders join the first batch they can still reach after proving (LEAD seconds),
// and each batch settles through the public pool under the contract's oracle checks (see replay/model.mjs).
// Bias: the replayed swaps also stay in the pool's history, and single-range price impact ignores tick crossings.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearBatch, pricePath, sqrtPrice } from './replay/model.mjs'

const E = process.env
const RPC = E.ETH_RPC || 'https://ethereum-rpc.publicnode.com'
const HOURS = Number(E.HOURS || 24)
const CACHE = E.REPLAY_CACHE || join(tmpdir(), 'blindfold-replay')
const SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
const POOLS = {
  'usdc-weth': { address: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', fee: 0.0005, label: 'USDC/WETH 0.05%' },
  'wbtc-weth': { address: '0x4585FE77225b41b697C938B018E2Ac67Ac5a20c0', fee: 0.0005, label: 'WBTC/WETH 0.05%' },
  'uni-weth': { address: '0x1d42064Fc4Beb5F8aAF85F4617AE8b3b5B8Bd801', fee: 0.003, label: 'UNI/WETH 0.3%' },
}
// Contract parameters as configured in the fork tests (UniswapV3Market(..., 600, 30, 120, ..., 100)); maxObservationAge is a grid axis.
const BASE = { window: 600, maxDelay: 30, maxDeviationBps: 100, solverDelay: 12 }
const GRID = {
  batchLength: (E.BATCHES || '60,300,900').split(',').map(Number),
  slippageBps: (E.SLIPPAGE || '10,30,50,100').split(',').map(Number),
  lead: (E.LEAD || '120').split(',').map(Number), // seconds before commitsClose an order must be ready (client margin)
  maxObservationAge: (E.OBS_AGE || '120').split(',').map(Number), // 0 = check removed
}

async function rpc(method, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      const j = await res.json()
      if (j.error) throw new Error(`${method}: ${j.error.message}`)
      return j.result
    } catch (e) {
      if (attempt >= 3) throw e
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
    }
  }
}

const word = (data, i) => BigInt('0x' + data.slice(2 + 64 * i, 2 + 64 * (i + 1)))
const signed = (x, bits) => (x >= 1n << BigInt(bits - 1) ? x - (1n << BigInt(bits)) : x)

async function swapsOf(pool, from, to) {
  const file = join(CACHE, `${pool.address.toLowerCase()}-${from}-${to}.json`)
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
  const out = []
  for (let a = from; a <= to; a += 2000) {
    const b = Math.min(a + 1999, to)
    const logs = await rpc('eth_getLogs', [{ address: pool.address, topics: [SWAP], fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) }])
    for (const l of logs) {
      out.push({
        block: Number(l.blockNumber), logIndex: Number(l.logIndex), timestamp: Number(l.blockTimestamp),
        a0: signed(word(l.data, 0), 256).toString(), a1: signed(word(l.data, 1), 256).toString(),
        sqrtPriceX96: word(l.data, 2).toString(), liquidity: word(l.data, 3).toString(),
        tick: Number(signed(word(l.data, 4), 256)),
      })
    }
  }
  out.sort((x, y) => x.block - y.block || x.logIndex - y.logIndex)
  mkdirSync(CACHE, { recursive: true })
  writeFileSync(file, JSON.stringify(out))
  return out
}

/** Real swaps -> orders quoted at the pre-swap price, fee included, with a slippage limit. */
function ordersOf(swaps, fee, slippageBps) {
  const orders = []
  for (let i = 1; i < swaps.length; i++) {
    const s = swaps[i]
    const a0 = Number(s.a0), a1 = Number(s.a1)
    const zeroForOne = a0 > 0
    const amountIn = zeroForOne ? a0 : a1
    const actualOut = zeroForOne ? -a1 : -a0
    if (!(amountIn > 0) || !(actualOut > 0)) continue
    const pre = sqrtPrice(swaps[i - 1].sqrtPriceX96) ** 2
    const quoted = (zeroForOne ? amountIn * pre : amountIn / pre) * (1 - fee)
    orders.push({ t: s.timestamp, zeroForOne, amountIn, minOut: quoted * (1 - slippageBps / 10000), quoted, actualOut })
  }
  return orders
}

const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : 0)
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] }

function run(swaps, pool, { batchLength, slippageBps, lead, maxObservationAge }) {
  const cfg = { ...BASE, fee: pool.fee, maxObservationAge: maxObservationAge || Infinity }
  const path = pricePath(swaps)
  const orders = ordersOf(swaps, pool.fee, slippageBps)
  // Align the schedule like the contract: start on a drand round boundary (genesis + 3k).
  const t0 = swaps[0].timestamp - ((swaps[0].timestamp - 1692803367) % 3) + cfg.window
  const end = swaps[swaps.length - 1].timestamp - 60
  const batches = new Map()
  for (const o of orders) {
    if (o.t < t0) continue
    const b = Math.ceil((o.t + lead - t0) / batchLength) - 1
    const commitsClose = t0 + (b + 1) * batchLength
    const revealCloses = commitsClose + 6 + 24 // drand round 6 s after commits close, 24 s reveal window
    if (revealCloses + cfg.solverDelay > end) continue
    if (!batches.has(b)) batches.set(b, { orders: [], revealCloses })
    batches.get(b).orders.push(o)
  }
  const tally = { orders: 0, filled: 0, unfilled: 0, expired: 0, reasons: {}, waits: [], vsImmediateBps: [], batches: 0, twoSided: 0 }
  for (const { orders: os, revealCloses } of batches.values()) {
    tally.batches++
    if (os.some((o) => o.zeroForOne) && os.some((o) => !o.zeroForOne)) tally.twoSided++
    const r = clearBatch(os, { revealCloses }, path, cfg)
    for (const o of os) {
      tally.orders++
      if (r.reason && r.reason !== 'NoExecutablePrice') {
        tally.expired++
        tally.reasons[r.reason] = (tally.reasons[r.reason] ?? 0) + 1
      } else if (r.paid?.has(o)) {
        tally.filled++
        tally.waits.push(r.settleAt - o.t)
        tally.vsImmediateBps.push((r.paid.get(o) / o.actualOut - 1) * 10000)
      } else tally.unfilled++
    }
  }
  return {
    batchLength, slippageBps, lead, maxObservationAge, orders: tally.orders, batches: tally.batches,
    filledPct: pct(tally.filled, tally.orders), unfilledPct: pct(tally.unfilled, tally.orders), expiredPct: pct(tally.expired, tally.orders),
    expiredBy: tally.reasons, twoSidedBatchesPct: pct(tally.twoSided, tally.batches),
    medianWaitS: median(tally.waits), medianVsImmediateBps: median(tally.vsImmediateBps)?.toFixed(1) ?? null,
  }
}

const head = Number(BigInt(await rpc('eth_blockNumber', [])))
const from = head - Math.round((HOURS * 3600) / 12)
const keys = (E.POOLS || Object.keys(POOLS).join(',')).split(',')
const report = { chainId: 1, fromBlock: from, toBlock: head, hours: HOURS, contract: BASE, pools: {} }
for (const k of keys) {
  const pool = POOLS[k]
  const swaps = await swapsOf(pool, from, head)
  const span = swaps.length ? (swaps.at(-1).timestamp - swaps[0].timestamp) / 3600 : 0
  const rows = []
  for (const maxObservationAge of GRID.maxObservationAge) for (const lead of GRID.lead)
    for (const batchLength of GRID.batchLength) for (const slippageBps of GRID.slippageBps) {
      rows.push(run(swaps, pool, { batchLength, slippageBps, lead, maxObservationAge }))
    }
  report.pools[k] = { pool: pool.label, address: pool.address, swaps: swaps.length, swapsPerHour: Math.round(swaps.length / span), rows }
  console.log(`\n${pool.label}: ${swaps.length} swaps over ${span.toFixed(1)} h (${report.pools[k].swapsPerHour}/h)`)
  console.log('obs age | batch s | slip bps | lead s | orders | filled % | unfilled % | expired % (why) | 2-sided batches % | median wait s | median vs immediate bps')
  for (const r of rows) {
    const why = Object.entries(r.expiredBy).map(([k, v]) => `${k} ${v}`).join(', ')
    console.log(`${r.maxObservationAge || 'off'} | ${r.batchLength} | ${r.slippageBps} | ${r.lead} | ${r.orders} | ${r.filledPct} | ${r.unfilledPct} | ${r.expiredPct}${why ? ` (${why})` : ''} | ${r.twoSidedBatchesPct} | ${r.medianWaitS} | ${r.medianVsImmediateBps}`)
  }
}
if (E.REPLAY_OUT) writeFileSync(E.REPLAY_OUT, JSON.stringify(report, null, 2) + '\n')
