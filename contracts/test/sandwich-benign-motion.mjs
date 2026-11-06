// SEC-03/SEC-07 read-only measurement: benign price motion of the USDC/WETH 0.05% v3 pool from public Swap logs.
// Estimates how often honest settlement would be rejected by (a) the market's spot-vs-reference band and
// (b) a size-aware user limit fixed at commit time. Reads only; sends no transactions.
//
//   source env.sh && node contracts/test/sandwich-benign-motion.mjs   # BLOCKS (default 9800), ETH_RPC, MOTION_OUT
// Public RPC log retention bounds the sample (~10k recent blocks on publicnode); it is one recent period, not a
// stress sample. Ticks are piecewise constant between swaps; the 600 s mean is the time-weighted mean tick
// (Uniswap v3 oracle semantics), so this is an approximation of UniswapV3Market.referencePrice, not a replay of it.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const root = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(join(root, 'packages/solver/package.json'))
const { createPublicClient, http, parseAbiItem } = require('viem')

const POOL = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'
const RPC = process.env.ETH_RPC || 'https://ethereum-rpc.publicnode.com'
const BLOCKS = BigInt(process.env.BLOCKS || 9800)
const OUT = process.env.MOTION_OUT || '/tmp/blindfold-benign-motion.json'
const WINDOW = 600
const client = createPublicClient({ transport: http(RPC, { timeout: 60_000, retryCount: 5, retryDelay: 2000 }) })
const swap = parseAbiItem('event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)')

const head = await client.getBlockNumber()
const from = head - BLOCKS
const logs = []
for (let b = from; b <= head; b += 1000n) {
  const to = b + 999n > head ? head : b + 999n
  logs.push(...await client.getLogs({ address: POOL, event: swap, fromBlock: b, toBlock: to }))
  await new Promise((r) => setTimeout(r, 300)) // stay well under public RPC rate limits
}
// Logs carry blockTimestamp on this RPC; only the range ends need headers.
const ts = new Map()
for (const l of logs) {
  if (l.blockTimestamp == null) throw new Error('RPC logs lack blockTimestamp; this script needs them')
  ts.set(l.blockNumber, Number(l.blockTimestamp))
}
for (const n of [from, head]) ts.set(n, Number((await client.getBlock({ blockNumber: n })).timestamp))
// Tick in effect after each block's last swap (oracle: the next block's interval uses it).
const lastTick = new Map()
for (const l of logs) lastTick.set(l.blockNumber, Number(l.args.tick))
const steps = [...lastTick].map(([n, tick]) => ({ t: ts.get(n), tick })).sort((a, b) => a.t - b.t)
const t0 = steps[0].t + WINDOW, t1 = ts.get(head) - 300 // every horizon stays inside the sample
const bps = (dTick) => (Math.pow(1.0001, dTick) - 1) * 1e4
// Cumulative tick-seconds for O(log n) window means.
const cum = [0]
for (let i = 1; i < steps.length; i++) cum.push(cum[i - 1] + steps[i - 1].tick * (steps[i].t - steps[i - 1].t))
const idx = (t) => { let lo = 0, hi = steps.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (steps[m].t <= t) lo = m; else hi = m - 1 } return lo }
const spot = (t) => steps[idx(t)].tick
const acc = (t) => { const i = idx(t); return cum[i] + steps[i].tick * (t - steps[i].t) }
const mean = (end) => (acc(end) - acc(end - WINDOW)) / WINDOW

const samples = []
for (let t = t0; t <= t1; t += 12) {
  const m = mean(t)
  samples.push({
    // spot at settlement vs reference ending at reveal close; signed: + means price above reference
    dev12: bps(spot(t + 12) - m), dev30: bps(spot(t + 30) - m), dev120: bps(spot(t + 120) - m),
    // price change from commit-time quote to settlement for two schedule lengths (E1 schedule ~60 s; 300 s batch)
    drift60: bps(spot(t + 60) - spot(t)), drift150: bps(spot(t + 150) - spot(t)), drift300: bps(spot(t + 300) - spot(t)),
  })
}
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }
const frac = (xs, f) => xs.filter(f).length / xs.length
const abs = (k) => samples.map((s) => Math.abs(s[k]))
const report = { pool: POOL, rpc: RPC, fromBlock: from, toBlock: head, fromTime: ts.get(from), toTime: ts.get(head), swaps: logs.length, swapBlocks: lastTick.size,
  samples: samples.length, sampleSpacingSeconds: 12, windowSeconds: WINDOW, method: 'time-weighted mean tick vs post-swap spot tick; bps from 1.0001^dTick',
  absolutePercentiles: Object.fromEntries(['dev12', 'dev30', 'dev120', 'drift60', 'drift150', 'drift300'].map((k) => [k, Object.fromEntries([0.5, 0.9, 0.99, 0.999, 1].map((p) => [p, +pct(abs(k), p).toFixed(2)]))])),
  // Adverse = against the order: price down hurts a USDC (token0) seller, price up hurts a WETH (token1) seller.
  // Band rejection if adverse spot offset + execution cost (fee + own impact) exceeds the band. Costs bracket E1/SEC-01 clean runs.
  bandRejection: Object.fromEntries([25, 50, 100].map((band) => [band, Object.fromEntries([5, 10, 15, 25].map((cost) => [cost, {
    sellToken0: +frac(samples, (s) => -s.dev12 + cost > band).toFixed(5), sellToken1: +frac(samples, (s) => s.dev12 + cost > band).toFixed(5),
    spotCheckOnly: +frac(samples, (s) => Math.abs(s.dev12) > band).toFixed(5),
    // default deployment: maxDelay = settleLength = 120 s, so a late honest settlement sees dev120
    sellToken0At120s: +frac(samples, (s) => -s.dev120 + cost > band).toFixed(5), sellToken1At120s: +frac(samples, (s) => s.dev120 + cost > band).toFixed(5) }]))])),
  // Size-aware limit fixed at commit: honest non-fill if adverse drift to settlement exceeds the tolerance.
  limitNonFill: Object.fromEntries([5, 10, 25, 50].map((tol) => [tol, {
    horizon60: { sellToken0: +frac(samples, (s) => -s.drift60 > tol).toFixed(5), sellToken1: +frac(samples, (s) => s.drift60 > tol).toFixed(5) },
    horizon150: { sellToken0: +frac(samples, (s) => -s.drift150 > tol).toFixed(5), sellToken1: +frac(samples, (s) => s.drift150 > tol).toFixed(5) },
    horizon300: { sellToken0: +frac(samples, (s) => -s.drift300 > tol).toFixed(5), sellToken1: +frac(samples, (s) => s.drift300 > tol).toFixed(5) } }])),
}
writeFileSync(OUT, JSON.stringify(report, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
console.log(JSON.stringify(report, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
