// The Court watcher service (S16, #22): `npm start` keeps watching; `npm start -- --once` runs one tick and exits
// (non-zero if the tick failed). Discovery and proving run as separate stages; see watcher.mjs.
// Env (all optional): ETH_RPC, V4_POOL_MANAGER, BASE_RPC (lib.mjs); WATCH_DIR (.watcher: state + claims);
// WATCH_START (first block when there is no state; default head - CONFIRMATIONS); CONFIRMATIONS (3); OVERLAP (12);
// MAX_BLOCKS (50 per tick); CONCURRENCY (4); PROVE_LIMIT (2 per tick); MAX_ATTEMPTS (3); PROVE_TIMEOUT_MS (300000);
// POLL_MS (12000); RPC_TIMEOUT_MS (15000, lib.mjs); ANCHOR=1 builds L1 anchors for claims judged on Base.
// shortcut: claims are proven and kept, not submitted. Submitting needs a signed Protected receipt for the victim
// tx (the demo-bots RPC, Phase 2); pass a `submit` to createWatcher once receipts exist.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ETH_RPC, rpc } from './lib.mjs'
import { createWatcher, fileStore } from './watcher.mjs'

const E = process.env
const here = fileURLToPath(new URL('.', import.meta.url))
const DIR = E.WATCH_DIR || join(here, '.watcher')
const num = (v, d) => (v === undefined ? d : Number(v))

/** Runs prove.mjs for one discovery, writing claims/<block>-<victim index>.json. */
function prove(item) {
  mkdirSync(join(DIR, 'claims'), { recursive: true })
  const out = join(DIR, 'claims', `${item.block}-${item.victim[0]}.json`)
  const env = {
    ...E, BLOCK: String(item.block), FRONT: item.front.join(':'), VICTIM: item.victim.join(':'),
    BACK: item.back.join(':'), OUT: out, ...(item.v4 ? { V4: '1', POOLID: item.poolId } : { POOL: item.pool }),
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(here, 'prove.mjs')], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (b) => { err = (err + b).slice(-2000) })
    const timer = setTimeout(() => child.kill('SIGKILL'), num(E.PROVE_TIMEOUT_MS, 300_000))
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) return resolve({ path: out })
      // Node ends a crash with its version line; report the error line instead
      const why = err.split('\n').find((l) => /Error/.test(l)) ?? err.trim().split('\n').pop()
      reject(new Error(signal ? `prove.mjs killed (${signal})` : `prove.mjs exited ${code}: ${why?.trim()}`))
    })
  })
}

const watcher = createWatcher({
  call: (method, params) => rpc(ETH_RPC, method, params),
  store: fileStore(join(DIR, 'state.json')),
  start: E.WATCH_START === undefined ? undefined : Number(E.WATCH_START),
  confirmations: num(E.CONFIRMATIONS, 3),
  overlap: num(E.OVERLAP, 12),
  maxBlocks: num(E.MAX_BLOCKS, 50),
  concurrency: num(E.CONCURRENCY, 4),
  proveLimit: num(E.PROVE_LIMIT, 2),
  maxAttempts: num(E.MAX_ATTEMPTS, 3),
  prove,
  log: (m) => console.error(`watcher: ${m}`),
})

const once = process.argv.includes('--once')
for (;;) {
  try {
    const t = await watcher.tick()
    const range = t.to >= t.from ? `blocks ${t.from}-${t.to}` : `waiting for block ${t.from}`
    console.log(`${range}: ${t.found} new, ${t.proven} proven, ${t.reorged} dropped by reorg`)
  } catch (e) {
    console.error(`watcher: tick failed, state kept: ${e.shortMessage ?? e.message} (ETH_RPC ${ETH_RPC})`)
    if (once) process.exit(1)
  }
  if (once) break
  await new Promise((r) => setTimeout(r, num(E.POLL_MS, 12_000)))
}
