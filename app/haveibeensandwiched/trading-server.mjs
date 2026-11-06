import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const number = (v) => typeof v === 'string' && /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(v) && v.length <= 80
export function command(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid request')
  const { action, side, amount, minimum, token } = input
  if (['status', 'track', 'blockers', 'resume-admission'].includes(action)) return [action]
  if (action === 'cleanup' || action === 'cleanup-preview') return action === 'cleanup' ? ['cleanup'] : ['cleanup', '--dry-run']
  if (['deposit', 'withdraw'].includes(action) && ['token0', 'token1'].includes(token) && (number(amount) || (action === 'withdraw' && amount === 'all'))) return [action, token, amount]
  if (['preflight', 'commit'].includes(action) && ['buy', 'sell'].includes(side) && number(amount) && number(minimum)) return ['commit', side, amount, minimum, ...(action === 'preflight' ? ['--dry-run'] : [])]
  throw Error('Invalid action or arguments')
}

export function createJobs({ start = (args) => spawn(process.execPath, ['packages/client/cli.mjs', ...args], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }) } = {}) {
  const jobs = new Map()
  let busy = false
  return {
    get: (id) => jobs.get(id),
    start(input) {
      const args = command(input)
      if (busy) throw Error('Another CLI command is running')
      const child = start(args)
      const id = randomUUID(), job = { state: 'running', output: '' }
      jobs.set(id, job); busy = true
      const append = (chunk) => { job.output = (job.output + chunk.toString()).slice(-32000) }
      child.stdout.on('data', append); child.stderr.on('data', append)
      child.once('error', (e) => { append(e.message); job.state = 'failed'; busy = false })
      child.once('close', (code) => { if (job.state === 'running') job.state = code === 0 ? 'done' : 'failed'; busy = false })
      if (jobs.size > 50) jobs.delete(jobs.keys().next().value)
      return id
    },
  }
}
