import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLIENT_STATE = mkdtempSync(join(tmpdir(), 'blindfold-lock-'))
const { statePath, withStateLock } = await import('../state.mjs')
const dep = { chainId: 31337, settlement: '0x0000000000000000000000000000000000000001' }
const owner = '0x0000000000000000000000000000000000000002'
const lock = () => `${statePath(dep, owner)}.lock`
const exitedPid = () => spawnSync(process.execPath, ['-e', '']).pid

test('a lock held by a running process says to wait and keeps the lock', async () => {
  writeFileSync(lock(), String(process.pid))
  await assert.rejects(withStateLock(dep, owner, async () => 'ran'), /locked by running process/)
  assert.ok(existsSync(lock()))
})

test('a lock left by an exited process is cleared and the command runs', async () => {
  writeFileSync(lock(), String(exitedPid()))
  assert.equal(await withStateLock(dep, owner, async () => 'ran'), 'ran')
  assert.ok(!existsSync(lock()), 'the lock is released afterwards')
})

test('an empty lock is only stale once it is a minute old', async () => {
  writeFileSync(lock(), '')
  await assert.rejects(withStateLock(dep, owner, async () => 'ran'), /try again/)
  const old = new Date(Date.now() - 120_000)
  utimesSync(lock(), old, old)
  assert.equal(await withStateLock(dep, owner, async () => 'ran'), 'ran')
})
