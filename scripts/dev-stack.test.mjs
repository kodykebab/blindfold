// Opt-in smoke check for the actual proof-enforced local developer stack; no proof is generated here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseStatus } from '../app/haveibeensandwiched/status.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
test('developer stack deploys real admission contracts and serves a funded local account', { skip: process.env.DEV_E2E !== '1', timeout: 120_000 }, async () => {
  assert.ok(process.env.ADMISSION_PARAMS && process.env.ADMISSION_PROVER, 'provide prepared development artifacts')
  const child = spawn(process.execPath, ['scripts/dev-stack.mjs'], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stderr.on('data', (chunk) => { log += chunk.toString() })
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`local stack did not start: ${log}`)), 90000)
      child.stdout.on('data', (chunk) => {
        log += chunk.toString()
        const match = log.match(/LOCAL_WEB_URL=(http:\/\/127\.0\.0\.1:\d+\/trade)/)
        if (match) { clearTimeout(timer); resolve(match[1]) }
      })
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', (code) => { clearTimeout(timer); reject(Error(`local stack exited ${code}: ${log}`)) })
    })
    assert.equal((await fetch(url)).status, 200)
    const origin = new URL(url).origin
    async function readStatus() {
      const response = await fetch(`${origin}/api/trade`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-blindfold-request': '1' }, body: JSON.stringify({ action: 'status' }) })
      assert.equal(response.status, 202)
      const { id } = await response.json()
      let job
      for (let i = 0; i < 200; i++) { job = await (await fetch(`${origin}/api/trade/${id}`)).json(); if (job.state !== 'running') break; await new Promise((resolve) => setTimeout(resolve, 100)) }
      assert.equal(job.state, 'done', job.output)
      return parseStatus(job.output)
    }
    const status = await readStatus()
    assert.ok(status?.account); assert.equal(status.rows.length, 2)
    assert.ok(status.rows.every((row) => /^100 /.test(row.wallet)), 'both local test tokens are funded')
    assert.equal(status.preparation, 'preparation: none')
    let solverStatus
    for (let i = 0; i < 100 && !solverStatus; i++) {
      for (const line of log.split('\n')) { try { const value = JSON.parse(line); if (value.solver && Array.isArray(value.settled)) solverStatus = value } catch {} }
      if (!solverStatus) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(solverStatus, 'solver emits a JSON status cycle')
    assert.deepEqual(solverStatus.errors, [])
    const healthPath = log.match(/Service health: (.+)/)?.[1]
    assert.ok(healthPath, 'the stack reports where its service health is written')
    let health
    for (let i = 0; i < 100 && !health?.services?.solver?.detail?.startsWith('last cycle'); i++) {
      try { health = JSON.parse(readFileSync(healthPath, 'utf8')) } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(health?.ok, true, JSON.stringify(health))
    assert.deepEqual(Object.keys(health.services), ['rpc', 'deployment', 'prover', 'keeper', 'solver'])
    const directory = log.match(/Local deployment and private state: (.+)/)?.[1]
    assert.ok(directory)
    const dep = JSON.parse(readFileSync(join(directory, 'blindfold.local.json'), 'utf8'))
    const latestBlock = async () => {
      const response = await fetch(dep.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }) })
      return BigInt((await response.json()).result.timestamp)
    }
    const before = await latestBlock()
    await new Promise((resolve) => setTimeout(resolve, 2200))
    assert.ok((await latestBlock()) > before, 'the local chain clock advances while the client is idle')
    const stateDir = join(directory, 'state'); mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, `${dep.chainId}-${dep.settlement}-${status.account}.json`.toLowerCase()), '{invalid', { mode: 0o600 })
    assert.equal((await readStatus()).preparation, 'preparation: local state unreadable; restore a backup')
  } finally { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit') } }
})
