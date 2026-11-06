// Opt-in: an isolated Anvil, the real local client, and the HTTP service. No private keys or existing chain are used.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { parseStatus } from './status.mjs'
import { parseTrack as parseTrackJson, parseBlockers as parseBlockersJson } from './orders.mjs'

const enabled = process.env.WEB_E2E === '1'
const testKeys = { PRIVATE_KEY: '', MNEMONIC: 'test test test test test test test test test test test junk' }
async function port() {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening'); const value = server.address().port
  await new Promise((resolve) => server.close(resolve)); return value
}
async function web(c, state) {
  const p = await port(), origin = `http://127.0.0.1:${p}`
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('.', import.meta.url),
    env: { ...process.env, PORT: String(p), OFFLINE: '1', RPC_URL: c.rpc, DEPLOYMENTS: c.deployments,
      ...testKeys, CLIENT_ACCOUNT_INDEX: '10', CLIENT_STATE: state, DRAND: (await import('../../packages/client/test/chain.mjs')).DRAND, PRIVATE_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'] })
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(([code]) => { throw Error(`server exited ${code}`) })])
  return {
    async run(body) {
      const response = await fetch(`${origin}/api/trade`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-blindfold-request': '1' }, body: JSON.stringify(body) })
      assert.equal(response.status, 202, await response.clone().text())
      const { id } = await response.json()
      for (let i = 0; i < 600; i++) {
        const job = await (await fetch(`${origin}/api/trade/${id}`)).json()
        if (job.state !== 'running') return { ...job, id }
        await new Promise((r) => setTimeout(r, 100))
      }
      throw Error('CLI job did not finish')
    },
    async get(id) { return (await fetch(`${origin}/api/trade/${id}`)).json() },
    async stop() { child.kill(); await once(child, 'exit') },
  }
}

test('real CLI backup exports a committed order and restores it to another local state directory', { skip: !enabled, timeout: 120_000 }, async () => {
  const { localChain, user } = await import('../../packages/client/test/chain.mjs')
  const c = await localChain({ schedule: { batchLength: 300, settleLength: 30 } })
  let original, restored
  try {
    for (const token of [c.token0, c.token1]) await c.mint(user(10).address, token, 100n * 10n ** 18n)
    const commit = await c.cli(10, ['commit', 'sell', '1', '0.9'], testKeys)
    assert.equal(commit.code, 0, commit.err)
    original = await web(c, join(c.dir, 'state'))
    const status = await original.run({ action: 'status' })
    assert.equal(status.state, 'done', status.output)
    const parsed = parseStatus(status.output)
    assert.equal(parsed.account.toLowerCase(), user(10).address.toLowerCase())
    assert.equal(parsed.rows.length, 2)
    assert.equal(parsed.tokens[0].decimals, 18, 'status --json reports token decimals')
    assert.equal(parsed.tokens[1].decimals, 18)
    assert.equal((await original.get(status.id)).state, 'done', 'a new page can recover an existing non-secret job result')
    assert.match(parsed.open, /open commitments: 1/)
    const tracked = await original.run({ action: 'track' })
    assert.equal(tracked.state, 'done', tracked.output)
    assert.equal(parseTrackJson(tracked.output).orders?.[0]?.state, 'committed') // track and blockers answer in JSON
    const blockers = await original.run({ action: 'blockers' })
    assert.equal(blockers.state, 'done', blockers.output)
    assert.equal(parseBlockersJson(blockers.output).steps?.[0]?.state, 'committed')
    const exportJob = await original.run({ action: 'backup-export' })
    assert.equal(exportJob.state, 'done', exportJob.output)
    const backup = JSON.parse(exportJob.backup)
    assert.equal(backup.commitments.length, 1)
    assert.equal((await original.get(exportJob.id)).backup, undefined, 'private backup leaves job history after delivery')
    restored = await web(c, join(c.dir, 'restored'))
    const damaged = structuredClone(backup); damaged.commitments[0].salt = `0x${'00'.repeat(32)}`
    const rejected = await restored.run({ action: 'backup-import', backup: JSON.stringify(damaged) })
    assert.equal(rejected.state, 'failed'); assert.match(rejected.output, /refusing to import/)
    const accepted = await restored.run({ action: 'backup-import', backup: exportJob.backup })
    assert.equal(accepted.state, 'done', accepted.output)
    assert.match(accepted.output, /1 commitment\(s\) saved/)
    const path = join(c.dir, 'verified.json')
    const check = await c.cli(10, ['export-state', path], { ...testKeys, CLIENT_STATE: join(c.dir, 'restored') })
    assert.equal(check.code, 0, check.err)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).commitments, backup.commitments)
  } finally { if (restored) await restored.stop(); if (original) await original.stop(); c.stop() }
})
