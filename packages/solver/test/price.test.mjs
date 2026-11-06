import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Q96, atBps, distBps, limitPriceX96, findBand, solve, allocationsAt, net0At, marginalPriceX96, SearchBudgetExceeded } from '../price.mjs'

const gcd = (a,b) => b === 0n ? a : gcd(b,a%b)
const E = 10n ** 18n
const order = (id, zeroForOne, amountIn, minAmountOut) => ({ id, zeroForOne, amountIn, minAmountOut })

/**
 * A fake settle with the contract's rules: fills follow from the price (or the marginal fill), and the
 * post-swap price (linear impact: `depth` token0 moves it 100%) must be within tolerance of the price.
 */
function market({ pool = Q96, depth = 5_000n * E, toleranceBps = 100, orders }) {
  const calls = { n: 0 }
  const simulate = async (p, m) => {
    calls.n++
    const ref = m && orders.find((o) => o.id === m.id)
    let net0 = 0n // token0 the batch sells into the pool
    for (const o of orders) {
      let amountIn = o.amountIn
      if (ref && o.zeroForOne === ref.zeroForOne && o.minAmountOut * ref.amountIn >= ref.minAmountOut * o.amountIn) {
        if (o.minAmountOut * ref.amountIn > ref.minAmountOut * o.amountIn) continue
        const limit = limitPriceX96(ref)
        if (limit === null || distBps(limit, p) > BigInt(toleranceBps) || m.amountIn >= ref.amountIn) return { ok: false, error: 'InvalidMarginalOrder' }
        amountIn = o.amountIn * m.amountIn / ref.amountIn
        let minimum = (o.minAmountOut * amountIn + o.amountIn - 1n) / o.amountIn
        let out = o.zeroForOne ? amountIn * p / Q96 : amountIn * Q96 / p
        if (out < minimum) {
          const lot = o.amountIn / gcd(o.amountIn,o.minAmountOut)
          amountIn = amountIn / lot * lot
          minimum = (o.minAmountOut * amountIn + o.amountIn - 1n) / o.amountIn
          out = o.zeroForOne ? amountIn * p / Q96 : amountIn * Q96 / p
        }
        if (amountIn === 0n) continue
        if (out === 0n || out < minimum) return { ok: false, error: 'PartialLimit' }
      } else {
        const out = o.zeroForOne ? (o.amountIn * p) / Q96 : (o.amountIn * Q96) / p
        if (out === 0n || out < o.minAmountOut) continue
      }
      net0 += o.zeroForOne ? amountIn : -((amountIn * Q96) / p)
    }
    const post = pool - (pool * net0) / depth
    const diff = post > p ? post - p : p - post
    return diff * 10_000n <= BigInt(toleranceBps) * p ? { ok: true } : { ok: false, poolX96: post }
  }
  return { simulate, calls, pool, toleranceBps, orders }
}

test('limitPriceX96 is exactly where quote starts to hold', () => {
  const sell = order(1n, true, 100n * E, 95n * E)
  const ls = limitPriceX96(sell)
  assert.ok((sell.amountIn * ls) / Q96 >= sell.minAmountOut)
  assert.ok((sell.amountIn * (ls - 1n)) / Q96 < sell.minAmountOut)
  const buy = order(2n, false, 50n * E, 45n * E)
  const lb = limitPriceX96(buy)
  assert.ok((buy.amountIn * Q96) / lb >= buy.minAmountOut)
  assert.ok((buy.amountIn * Q96) / (lb + 1n) < buy.minAmountOut)
  assert.equal(limitPriceX96(order(3n, true, 1n, 0n)), null)
})

test('two-sided batch: settles at the middle of the accepted band, near the post-swap price', async () => {
  const m = market({ orders: [order(1n, true, 100n * E, 95n * E), order(2n, false, 50n * E, 45n * E)] })
  const band = await findBand(m.simulate, m.pool, m.toleranceBps, m.orders)
  assert.ok(band, 'a band exists')
  assert.ok(band.lo < band.hi && band.lo <= band.priceX96 && band.priceX96 <= band.hi)
  assert.ok((await m.simulate(band.priceX96)).ok)
  // net 50 token0 sold into a 5000-deep pool: post-swap ~0.99, so the band is centred there
  assert.ok(distBps(band.priceX96, atBps(Q96, -100)) <= 10n, 'midpoint ~0.99')
})

test('an empty batch settles at the pool price', async () => {
  const m = market({ orders: [] })
  const s = await solve({ ...m, poolX96: m.pool })
  assert.ok(s && !s.marginal && distBps(s.priceX96, m.pool) <= 1n)
})

test('poison order: no full-fill price exists, so one order fills partially at its own limit (R1)', async () => {
  // REVIEW.md R1: a 300 sell with limit 0.975 moves the pool ~6% if filled and keeps it near 1.0 if not
  const poison = order(2n, true, 300n * E, (300n * E * 975n) / 1000n)
  const m = market({ orders: [order(1n, false, 10n * E, 9n * E), poison] })
  assert.equal(await findBand(m.simulate, m.pool, m.toleranceBps, m.orders), null, "no band")
  assert.equal(await solve({ ...m, poolX96: m.pool, marginal: false }), null, 'stuck without the R1 overload')
  const s = await solve({ ...m, poolX96: m.pool })
  assert.ok(s?.marginal, 'a marginal solution')
  assert.equal(s.marginal.id, 2n)
  assert.ok(s.marginal.amountIn > 0n && s.marginal.amountIn < poison.amountIn, 'partial fill')
  assert.equal(s.priceX96, limitPriceX96(poison))
  assert.ok((await m.simulate(s.priceX96, s.marginal)).ok)
})

test('a large one-sided batch still converges (price far from the pool)', async () => {
  const m = market({ orders: [order(1n, false, 400n * E, 1n)] }) // buys move the price ~8% up
  const s = await solve({ ...m, poolX96: m.pool })
  assert.ok(s && !s.marginal)
  assert.ok((await m.simulate(s.priceX96)).ok)
  assert.ok(s.priceX96 > atBps(m.pool, 500), 'well above the starting pool price')
})

/** Deterministic PRNG so failures name a reproducible seed. */
function rng(seed) {
  let s = BigInt(seed)
  return () => {
    s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n)
    return s >> 33n
  }
}

function randomBatch(seed) {
  const r = rng(seed)
  const orders = []
  for (let i = 0, n = Number(r() % 13n); i < n; i++) {
    const sell = r() % 2n === 0n
    const amountIn = (1n + (r() % 300n)) * E
    const lim = 9000n + (r() % 2001n) // limit 0.90..1.10 of the starting pool price, in bps
    const minOut = r() % 4n === 0n ? 0n : sell ? (amountIn * lim) / 10_000n : (amountIn * 10_000n) / lim
    orders.push(order(BigInt(i), sell, amountIn, minOut))
  }
  return orders
}

test('random batches: never misses a full-fill price that exists, never returns one that does not settle', async () => {
  for (let seed = 1; seed <= 300; seed++) {
    const m = market({ orders: randomBatch(seed) })
    const s = await solve({ ...m, poolX96: m.pool, marginal: false })
    let feasible = null
    for (let k = -1500; k <= 1500 && feasible === null; k++) if ((await m.simulate(atBps(m.pool, k))).ok) feasible = k
    if (s) assert.ok((await m.simulate(s.priceX96)).ok, `seed ${seed}: returned price must settle`)
    else assert.equal(feasible, null, `seed ${seed}: missed a feasible price at ${feasible} bps`)
  }
})

test('random batches with the marginal fill: whatever it returns settles, and it rescues stuck batches', async (t) => {
  let stuck = 0
  let rescued = 0
  for (let seed = 1; seed <= 300; seed++) {
    const m = market({ orders: randomBatch(seed) })
    const s = await solve({ ...m, poolX96: m.pool })
    if (s) assert.ok((await m.simulate(s.priceX96, s.marginal)).ok, `seed ${seed}`)
    if (s?.marginal || !s) stuck++
    if (s?.marginal) rescued++
  }
  t.diagnostic(`${stuck} of 300 batches had no full-fill price; the marginal fill settled ${rescued} of them`)
  assert.ok(stuck > 0, 'the random batches exercise the marginal path')
  assert.equal(rescued, stuck, 'every stuck batch in this fixed model corpus is rescued')
})


test('equal-limit orders share the fraction regardless of reveal order', async () => {
  const orders = [order(8n, true, 1000n * E, 900n * E), order(3n, true, 500n * E, 450n * E)]
  const m = market({ orders, depth: 10_000n * E })
  const a = await solve({ ...m, poolX96: m.pool })
  const b = await solve({ ...m, orders: [...orders].reverse(), poolX96: m.pool })
  assert.ok(a?.marginal)
  assert.deepEqual(a, b)
  const fills = allocationsAt(orders, a.priceX96, a.marginal)
  assert.equal(fills[0], 2n * fills[1])
  assert.equal(net0At(orders, a.priceX96, a.marginal), fills[0] + fills[1])
  assert.ok((await m.simulate(a.priceX96, a.marginal)).ok)
})

test('priority excludes worse limits and fills better ones before the group', () => {
  const orders = [order(1n, true, 1000n, 900n), order(2n, true, 100n, 80n), order(3n, true, 100n, 95n)]
  assert.deepEqual(allocationsAt(orders, Q96, { id: 1n, amountIn: 540n }), [540n, 100n, 0n])
})

test('partial input below an exact lot stays unfilled without weakening the minimum', () => {
  const o = order(1n, true, 3n, 2n)
  assert.equal(marginalPriceX96([o], o, 2n), limitPriceX96(o))
  assert.deepEqual(allocationsAt([o], limitPriceX96(o), {id:1n,amountIn:2n}),[0n])
  const buy = order(2n, false, 3n, 2n)
  assert.equal(marginalPriceX96([buy], buy, 2n), limitPriceX96(buy))
  assert.deepEqual(allocationsAt([buy], limitPriceX96(buy), {id:2n,amountIn:2n}),[0n])
})

test('RPC failure propagates instead of being reported as an impossible batch', async () => {
  const failure = new Error('RPC unavailable')
  await assert.rejects(solve({ simulate: async () => { throw failure }, poolX96: Q96, toleranceBps: 100, orders: [] }), (e) => e === failure)
})

test('simulation budget exhaustion is explicit and bounded', async () => {
  let calls = 0
  await assert.rejects(solve({ simulate: async () => { calls++; return { ok: true } }, poolX96: Q96,
    toleranceBps: 100, orders: [], maxSimulations: 2 }), SearchBudgetExceeded)
  assert.equal(calls, 2)
})

test('unclassified full-fill failure still tries marginal groups', async () => {
  const orders = [order(1n, true, 1000n * E, 900n * E)]
  const m = market({ orders, depth: 5000n * E })
  const simulate = (p, partial) => partial ? m.simulate(p, partial) : { ok: false, error: 'Imbalanced' }
  const result = await solve({ simulate, poolX96: Q96, toleranceBps: 100, orders })
  assert.ok(result?.marginal)
  assert.ok((await simulate(result.priceX96, result.marginal)).ok)
})


test('known order boundaries avoid a raw-Q96 bisection at a poison gap', async () => {
  const orders = [order(1n, true, 1000n * E, 900n * E), order(2n, true, 500n * E, 450n * E)]
  const m = market({ orders, depth: 10000n * E })
  const s = await solve({ ...m, poolX96: m.pool })
  assert.ok(s?.marginal)
  assert.ok(m.calls.n < 30, `used ${m.calls.n} calls for a known discontinuity`)
})

test('a lowest-ID dust companion cannot control fraction resolution or block useful partial fills', async () => {
  for (const sell of [true,false]) {
    const orders = [order(0n,sell,10n,9n), order(1n,sell,1000n*E,900n*E)]
    const m = market({orders})
    const result = await solve({simulate:m.simulate,poolX96:Q96,toleranceBps:100,orders})
    assert.ok(result?.marginal)
    assert.equal(result.marginal.id,1n)
    const inputs = allocationsAt(orders,result.priceX96,result.marginal)
    assert.equal(inputs[0],0n)
    assert.ok(inputs[1]>0n)
    assert.ok((sell ? inputs[1]*result.priceX96/Q96 : inputs[1]*Q96/result.priceX96) >= (inputs[1]*9n+9n)/10n)
    assert.ok((await m.simulate(result.priceX96,result.marginal)).ok)
  }
})

test('coprime orders retain partial fills whenever their quoted minimum is met', () => {
  const o = order(0n,true,1001n,900n)
  assert.deepEqual(allocationsAt([o],Q96,{id:0n,amountIn:501n}),[501n])
  const atLimit = limitPriceX96(o)
  assert.deepEqual(allocationsAt([o],atLimit,{id:0n,amountIn:501n}),[0n])
})
