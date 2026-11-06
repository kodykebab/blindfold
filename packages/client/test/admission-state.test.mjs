import test from 'node:test'
import assert from 'node:assert/strict'
import { initialFunding, nextFunding, reconcileFunding, validateFunding, ZERO } from '../admission-state.mjs'
const dep = { chainId: 130, settlement: `0x${'01'.repeat(20)}` }
const owner = `0x${'02'.repeat(20)}`
const order = { zeroForOne: true, amountIn: 100n }
const blind = `0x${'03'.repeat(32)}`
const initial = initialFunding()
const next = nextFunding(dep, owner, initial, 7n, order, blind)
const chain = { batch: 7n, root: next.root, step: 1n }

test('cumulative state persists both directions and rejects stale openings', () => {
  const second = nextFunding(dep, owner, next, 7n, { zeroForOne: false, amountIn: 40n }, blind)
  assert.deepEqual(second.totals, [100n, 40n])
  assert.equal(second.step, 2n)
  assert.throws(() => validateFunding(dep, owner, { ...second, totals: [0n, 40n] }), /does not match/)
  assert.throws(() => validateFunding({ ...dep, chainId: 131 }, owner, second), /does not match/)
  assert.throws(() => reconcileFunding(dep, owner, initial, chain, 10n), /stale or missing/)
  assert.throws(() => nextFunding(dep, owner, next, 8n, order, blind), /active batch/)
})
test('interrupted successful submission reconciles without appending twice', () => {
  const pending = { ...initial, pending: { next, closes: 100n } }
  assert.deepEqual(reconcileFunding(dep, owner, pending, chain, 10n), next)
  assert.throws(() => reconcileFunding(dep, owner, pending, { batch: 0n, step: 0n, root: ZERO }, 10n), /pending/)
  assert.throws(() => nextFunding(dep, owner, pending, 7n, order, blind), /pending/)
})
test('failed submission stays blocked until deadline; closed state resets', () => {
  const pending = { ...initial, pending: { next, closes: 100n } }
  assert.deepEqual(reconcileFunding(dep, owner, pending, { batch: 0n, step: 0n, root: ZERO }, 100n), initial)
  assert.deepEqual(reconcileFunding(dep, owner, next, { batch: 0n, step: 0n, root: ZERO }, 100n), initial)
  assert.throws(() => validateFunding(dep, owner, { ...initial, totals: [1n, 0n] }), /must be zero/)
})

test('pending export can be restored before submission, then reconciled after success', async () => {
  const { restoreFunding } = await import('../admission-state.mjs')
  const pending = { ...initial, pending: { next, closes: 100n } }
  assert.deepEqual(restoreFunding(dep, owner, pending, { batch: 0n, step: 0n, root: ZERO }, 10n), pending)
  assert.deepEqual(restoreFunding(dep, owner, pending, chain, 10n), next)
  assert.throws(() => restoreFunding(dep, owner, { ...initial, pending: { next, closes: '100' } }, chain, 10n), /invalid pending/)
})

test('private state serializes competing mutations, releases failed locks, and writes owner-only files', async () => {
  const { mkdtempSync, statSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { withStateLock, writeState, loadState, statePath } = await import('../state.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'blindfold-state-test-')), previous = process.env.CLIENT_STATE
  process.env.CLIENT_STATE = dir
  try {
    await withStateLock(dep, owner, async () => {
      await assert.rejects(withStateLock(dep, owner, async () => {}), /state is locked/)
      writeState(dep, owner, { chainId: dep.chainId, settlement: dep.settlement, owner, commitments: [], admission: next })
    })
    assert.deepEqual(loadState(dep, owner).admission, next)
    assert.equal(statSync(statePath(dep, owner)).mode & 0o777, 0o600)
    await assert.rejects(withStateLock(dep, owner, async () => { throw new Error('submission failed') }), /submission failed/)
    await withStateLock(dep, owner, async () => {})
  } finally {
    if (previous === undefined) delete process.env.CLIENT_STATE; else process.env.CLIENT_STATE = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
