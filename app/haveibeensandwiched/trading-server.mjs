import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const number = (v) => typeof v === 'string' && /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(v) && v.length <= 80
export function command(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid request')
  const { action, side, amount, minimum, token, batch } = input
  if (action === 'prepare-admission' && typeof batch === 'string' && /^(0|[1-9]\d{0,19})$/.test(batch) && BigInt(batch) < (1n << 64n)) return ['prepare-admission', batch]
  if (['track', 'blockers'].includes(action)) return [action, '--json']
  if (action === 'status') return ['status', '--json']
  if (action === 'resume-admission') return [action]
  if (action === 'cleanup') return ['cleanup', '--json']
  if (action === 'cleanup-preview') return ['cleanup', '--dry-run', '--json']
  if (['deposit', 'withdraw'].includes(action)) {
    if (!['token0', 'token1'].includes(token)) throw Error('not supported in this deployment')
    if (number(amount) || (action === 'withdraw' && amount === 'all')) return [action, token, amount]
  }
  if (['preflight', 'commit'].includes(action) && ['buy', 'sell'].includes(side) && number(amount) && number(minimum)) return ['commit', side, amount, minimum, ...(action === 'preflight' ? ['--dry-run'] : []), '--vault-only', '--both-funded']
  throw Error('Invalid action or arguments')
}

export function createJobs({ start = (args) => spawn(process.execPath, ['packages/client/cli.mjs', ...args], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }) } = {}) {
  const jobs = new Map()
  let active = null
  return {
    get(id) {
      const job = jobs.get(id)
      if (!job) return undefined
      const result = { ...job }
      // Exported private state is delivered once and never kept in the job history.
      if (job.backup !== undefined) delete job.backup
      return result
    },
    start(input) {
      if (active) throw Error('Another CLI command is running')
      let args, dir
      if (input?.action === 'backup-export' || input?.action === 'backup-import') {
        if (input.action === 'backup-import') {
          if (typeof input.backup !== 'string' || Buffer.byteLength(input.backup) > 1_000_000) throw Error('Invalid or oversized backup')
          try { const parsed = JSON.parse(input.backup); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error() } catch { throw Error('Backup must be a JSON object') }
        }
        dir = mkdtempSync(join(tmpdir(), 'blindfold-web-backup-'))
        const file = join(dir, 'state.json')
        try {
          if (input.action === 'backup-import') writeFileSync(file, input.backup, { mode: 0o600, flag: 'wx' })
          args = [input.action === 'backup-export' ? 'export-state' : 'import-state', file]
        } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e }
      } else args = command(input)
      let child
      try { child = start(args) } catch (e) { if (dir) rmSync(dir, { recursive: true, force: true }); throw e }
      const id = randomUUID(), job = { state: 'running', action: input.action, output: '' }
      jobs.set(id, job); active = id
      const append = (chunk) => { job.output = (job.output + chunk.toString().replaceAll(dir ?? '\0', '[private temporary file]')).slice(-32000) }
      const finish = (code) => {
        if (job.state !== 'running') return
        try {
          if (code === 0 && input.action === 'backup-export') job.backup = readFileSync(join(dir, 'state.json'), 'utf8')
          job.state = code === 0 ? 'done' : 'failed'
        } catch (e) { append(`Backup failed: ${e.message}`); job.state = 'failed' }
        finally { if (dir) rmSync(dir, { recursive: true, force: true }); if (active === id) active = null }
      }
      child.stdout.on('data', append); child.stderr.on('data', append)
      child.once('error', (e) => { append(e.message); finish(1) })
      child.once('close', finish)
      if (jobs.size > 50) jobs.delete(jobs.keys().next().value)
      return id
    },
  }
}
