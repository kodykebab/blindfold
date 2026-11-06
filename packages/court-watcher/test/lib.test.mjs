import { test } from 'node:test'
import assert from 'node:assert/strict'

const BOT = '0xb07', USER = '0xa11ce', ROUTER = '0xrouter'
const swap = (txIndex, from, caller, a0, a1) => ({ v4: false, pool: '0xpool', poolId: '0x00', txIndex, logIndex: 0, from, caller, a0, a1 })

test('finds a sandwich: front and victim pay token0 in, back closes it at a profit', async () => {
  const { findSandwiches } = await import('../lib.mjs')
  // pool-side amounts, as SandwichCourtVerifier's predicate test: front 50 -> 100, victim 10 -> 18, back 100 -> 52
  const found = findSandwiches([swap(1, BOT, BOT, 50n, -100n), swap(2, USER, ROUTER, 10n, -18n), swap(3, BOT, BOT, -52n, 100n)])
  assert.equal(found.length, 1)
  assert.equal(found[0].profit, 2n)
  assert.equal(found[0].profitInToken0, true)
})

test('rejects what the verifier rejects', async () => {
  const { findSandwiches } = await import('../lib.mjs')
  const front = swap(1, BOT, BOT, 50n, -100n), victim = swap(2, USER, ROUTER, 10n, -18n)
  assert.equal(findSandwiches([front, victim, swap(3, '0xother', BOT, -52n, 100n)]).length, 0, 'different back signer')
  assert.equal(findSandwiches([front, victim, swap(3, BOT, BOT, -26n, 50n)]).length, 0, 'closes only half')
  assert.equal(findSandwiches([front, victim, swap(3, BOT, BOT, -49n, 100n)]).length, 0, 'a loss')
  assert.equal(findSandwiches([front, swap(2, USER, ROUTER, -10n, 18n), swap(3, BOT, BOT, -52n, 100n)]).length, 0, 'victim trades the other way')
  assert.equal(findSandwiches([front, victim, swap(3, BOT, '0xother', -52n, 100n)]).length, 0, 'back made by another contract')
  assert.equal(findSandwiches([front, swap(2, BOT, ROUTER, 10n, -18n), swap(3, BOT, BOT, -52n, 100n)]).length, 0, 'victim signed by the attacker')
  // the front pays nothing in (token1 = 0), however much the back gets: as the verifier's NotSandwich(3)
  const free = [swap(1, BOT, BOT, -100n, 0n), swap(2, USER, ROUTER, -18n, 10n), swap(3, BOT, BOT, 100n, -52n)]
  assert.equal(findSandwiches(free).length, 0, 'front paid nothing in')
})

test('S5: a victim on the same router as the attacker is still a victim', async () => {
  const { findSandwiches } = await import('../lib.mjs')
  // the attacker routes both legs through a public router that the victim also uses
  const found = findSandwiches([swap(1, BOT, ROUTER, 50n, -100n), swap(2, USER, ROUTER, 10n, -18n), swap(3, BOT, ROUTER, -52n, 100n)])
  assert.equal(found.length, 1)
  assert.equal(found[0].victim.from, USER)
})

test('S5: swapLogs reads the v3 pool caller (sender), not the recipient', async () => {
  const { swapLogs, V3_SWAP } = await import('../lib.mjs')
  const t = (b) => '0x' + '00'.repeat(12) + b.repeat(20)
  const receipt = {
    status: '0x1', transactionIndex: '0x1', from: '0xABC',
    logs: [{ address: '0xPOOL', topics: [V3_SWAP, t('aa'), t('bb')], data: '0x' + '00'.repeat(32 * 5) }],
  }
  assert.equal(swapLogs([receipt])[0].caller, '0x' + 'aa'.repeat(20))
})

test('V4_POOL_MANAGER selects which PoolManager logs count, and v4 amounts are negated to pool-side', async () => {
  process.env.V4_POOL_MANAGER = '0x1F98400000000000000000000000000000000004'
  const { swapLogs, V4_SWAP } = await import('../lib.mjs?local')
  const word = (x) => (x < 0n ? (1n << 256n) + x : x).toString(16).padStart(64, '0')
  const log = (address) => ({
    address, topics: [V4_SWAP, '0x' + '11'.repeat(32), '0x' + '00'.repeat(12) + 'ab'.repeat(20)],
    data: '0x' + word(-50n) + word(100n) + '00'.repeat(32 * 6),
  })
  const receipt = { status: '0x1', transactionIndex: '0x3', from: '0xABC', logs: [log('0x1f98400000000000000000000000000000000004'), log('0x000000000004444c5dc75cb358380d2e3de08a90')] }
  const swaps = swapLogs([receipt])
  assert.equal(swaps.length, 1, 'only the configured PoolManager')
  assert.equal(swaps[0].pool, '0x1f98400000000000000000000000000000000004')
  assert.deepEqual([swaps[0].a0, swaps[0].a1], [50n, -100n])
})
