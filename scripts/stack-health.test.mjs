import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stackHealth, formatHealth } from './stack-health.mjs'

const dep = { chainId: 31337, settlement: '0x1', vault: '0x2', token0: '0x3', token1: '0x4' }
const running = { exitCode: null, signalCode: null }
const now = Date.parse('2026-11-07T00:00:30Z')
const fresh = { at: '2026-11-07T00:00:25Z', errors: [] }
const pub = (over = {}) => ({ getChainId: async () => 31337, getBlockNumber: async () => 7n, getCode: async () => '0x60', ...over })
const base = { pub: pub(), dep, prover: process.execPath, keeper: { child: running, status: fresh }, solver: { child: running, status: fresh }, now }

test('every service up', async () => {
  const h = await stackHealth(base)
  assert.equal(h.ok, true, formatHealth(h))
})

test('each failure names the service and a next step', async () => {
  const cases = [
    [{ pub: pub({ getChainId: async () => { throw Error('ECONNREFUSED') } }) }, ['rpc', 'deployment']],
    [{ pub: pub({ getChainId: async () => 1 }) }, ['rpc', 'deployment']],
    [{ pub: pub({ getCode: async ({ address }) => address === '0x2' ? '0x' : '0x60' }) }, ['deployment']],
    [{ prover: '/nonexistent/local-prover' }, ['prover']],
    [{ prover: undefined }, ['prover']],
    [{ keeper: { child: { exitCode: 1 }, status: fresh } }, ['keeper']],
    [{ solver: { child: running, status: { at: '2026-11-06T23:59:00Z', errors: [] } } }, ['solver']],
    [{ solver: { child: running, status: { ...fresh, errors: [{ batch: '3', message: 'settle reverted' }] } } }, ['solver']],
  ]
  for (const [over, down] of cases) {
    const h = await stackHealth({ ...base, ...over })
    const failed = Object.entries(h.services).filter(([, s]) => !s.ok).map(([name]) => name)
    assert.deepEqual(failed, down, JSON.stringify(over))
    for (const name of failed) assert.ok(h.services[name].fix, `${name} has a next step`)
    assert.equal(h.ok, false)
  }
})

test('a service that has not reported yet is not counted as down', async () => {
  const h = await stackHealth({ ...base, keeper: { child: running, status: null } })
  assert.equal(h.services.keeper.ok, true)
})
