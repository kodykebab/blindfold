import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sweepStale } from '../sweep.mjs'

test('only old directories with our prefix are removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-test-'))
  const old = new Date(Date.now() - 60 * 60_000)
  const make = (name, aged) => { const p = join(dir, name); mkdirSync(p); writeFileSync(join(p, 'witness.json'), '{}'); if (aged) utimesSync(p, old, old); return p }
  const stale = make('blindfold-witness-old', true)
  const live = make('blindfold-witness-new', false)
  const other = make('someone-else-old', true)
  assert.deepEqual(sweepStale('blindfold-witness-', { dir }), [stale])
  assert.equal(existsSync(stale), false)
  assert.equal(existsSync(live), true, 'a proof that may still be running is kept')
  assert.equal(existsSync(other), true, 'other programs\' files are never touched')
  assert.deepEqual(sweepStale('x-', { dir: join(dir, 'missing') }), [])
})
