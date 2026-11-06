// Service worker: runs the flows, holds the bridge port, talks to the prover helper and the offscreen document, and
// keeps the batch clock with chrome.alarms. Chrome stops it when idle, so nothing lives only in memory: config and the
// encrypted state are in storage.local, the unlocked key, wallet and job records in storage.session.
import { createPublicClient, defineChain, http } from 'viem'
import { replacer, stateId } from './core.mjs'
import { createVault, importKey, exportKey, stateStore, unlockVault } from './vault.mjs'
import { flows } from './flows.mjs'
import { clearExports } from './jobs.mjs'
import { bridge as createBridge } from './bridge.mjs'
import { helper as createHelper } from './helper.mjs'

const BRIDGE_ORIGIN = globalThis.BLINDFOLD_BRIDGE_ORIGIN // replaced by build.mjs from BRIDGE_ORIGIN (D9)
const DEFAULT_RPC = 'http://127.0.0.1:8545'
const local = chrome.storage.local, session = chrome.storage.session
const ready = clearExports(session) // discard unread exports left by a previous worker
const fail = (msg) => { throw new Error(msg) }
const plain = (x) => JSON.parse(JSON.stringify(x, replacer)) // bigints as "123n", as in exports

// ---- bridge page and prover helper

const walletInfo = (m) => {
  if (m.type === 'hello') return session.set({ bridge: true })
  if (m.type === 'disconnected') return session.set({ bridge: false })
  if (m.type === 'wallets') return session.set({ wallets: m.wallets })
  if (m.type === 'wallet') return session.set({ wallet: m }).then(tick)
}
const bridge = createBridge({ origin: BRIDGE_ORIGIN, onWallet: walletInfo, onLate: (m) => late(m).catch((e) => console.warn('bridge:', e)), onError: (e) => console.warn('bridge:', e) })
chrome.runtime.onConnectExternal.addListener(bridge.accept)
session.set({ bridge: false }) // a fresh worker has no port; the bridge reconnects within a second

// Helper protocol 1 (packages/prover-helper): hello, then prepare and online on the same port (one host process).
const helper = createHelper()
async function prove({ manifestSha256, request }) {
  try {
    const hello = await helper.call('hello')
    if (hello.protocol !== 1) fail(`prover helper speaks protocol ${hello.protocol}; this extension needs 1`)
    if (hello.manifestSha256 !== manifestSha256) fail(`prover helper parameters ${hello.manifestSha256} do not match this deployment's ${manifestSha256}`)
    const prepared = await helper.call('prepare', { protocol: 1, manifestSha256, request })
    const { online } = await helper.call('online', { protocol: 1, session: prepared.session })
    return { ...prepared, online }
  } finally {
    helper.close()
  }
}

// ---- offscreen document (tlock)

async function offscreen(op, args) {
  if (!(await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length) {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'tlock ciphertext checks; the WASM prover later' })
      .catch((e) => { if (!/single offscreen/i.test(e.message)) throw e })
  }
  const r = await chrome.runtime.sendMessage({ target: 'offscreen', op, ...args })
  if (!r?.ok) fail(r?.error ?? 'offscreen document did not answer')
  return r.result
}

// ---- flow context

let abis
const loadAbis = () => (abis ??= fetch(chrome.runtime.getURL('abis.json')).then((r) => r.json()))

async function context(log = () => {}) {
  const { config } = await local.get('config')
  const dep = config?.deployment ?? fail('no deployment set: paste the deployment JSON under Settings')
  const { wallet, key } = await session.get(['wallet', 'key'])
  const owner = wallet?.accounts?.[0] ?? fail(`no wallet account: open ${BRIDGE_ORIGIN}/ and connect a wallet`)
  const rpcUrl = config.rpcUrl || DEFAULT_RPC
  const chain = defineChain({ id: dep.chainId, name: 'blindfold', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } })
  const pub = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 15_000, retryCount: 0 }), pollingInterval: 500 })
  const a = await loadAbis()
  const abi = { settlement: dep.admission?.manifestSha256 ? a.AdmittedSettlement : a.BlindfoldSettlement, vault: a.BlindfoldVault, erc20: a.MockERC20 }
  const states = key ? stateStore(local, await importKey(key)) : null
  const unlocked = () => states ?? fail('private state is locked: unlock it first')
  const ctx = {
    dep, abi, owner, pub, log, unlocked: !!states,
    store: { load: () => unlocked().load(dep, owner), write: (s) => unlocked().write(dep, owner, s) },
    sendTx: (tx, record) => sendTx(ctx, { ...tx, chain: { chainId: dep.chainId, rpcUrl } }, record),
    prove,
    tlock: {
      encrypt: (round, payload) => offscreen('encrypt', { round: String(round), payload, drand: config.drand }),
      check: (ciphertext, round, payload) => offscreen('check', { ciphertext, round: String(round), payload, drand: config.drand }),
    },
  }
  return ctx
}

// Each send is journaled in storage.session before it is posted. If the worker restarts while the wallet is open, the
// bridge re-delivers `sent` / `result` on reconnect (bridge v1) and late() still saves the hash with its order.
async function sendTx(ctx, tx, record) {
  const id = `tx-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
  const key = `send:${id}`
  await session.set({ [key]: plain({ record, owner: ctx.owner, settlement: ctx.dep.settlement }) })
  try {
    const r = await bridge.send({ ...tx, id }, (hash) => record && flows(ctx).recordSent(record, hash))
    await session.remove(key)
    return r.hashes.at(-1)
  } catch (e) {
    if (e.code !== 'DISCONNECTED') await session.remove(key) // a dropped port may still be answered after reconnect
    throw e
  }
}

async function late(m) {
  const key = `send:${m.id}`
  const sent = (await session.get(key))[key]
  if (!sent) return
  if (m.type === 'sent' && sent.record && m.hash) {
    const ctx = await context()
    if (ctx.owner.toLowerCase() !== sent.owner.toLowerCase() || ctx.dep.settlement.toLowerCase() !== sent.settlement.toLowerCase()) return
    await navigator.locks.request(lockName(ctx), () => flows(ctx).recordSent(sent.record, m.hash))
  }
  if (m.type === 'result') {
    await session.remove(key)
    tick()
  }
}

// One writer per account (Web Locks); a second mutation fails fast instead of queueing behind a wallet prompt.
const lockName = (ctx) => `blindfold:${stateId(ctx.dep, ctx.owner)}`
const withLock = (ctx, fn) => navigator.locks.request(lockName(ctx), { ifAvailable: true },
  (lock) => (lock ? fn() : fail('another operation is running for this account; wait for it to finish')))

const OPS = {
  status: (f) => f.status(),
  track: (f) => f.track(),
  blockers: (f) => f.blockers(),
  preflight: (f, a) => f.commit({ ...a, dryRun: true }),
  export: (f) => f.exportState(),
  deposit: (f, a) => f.deposit(a.token, a.amount),
  commit: (f, a) => f.commit({ ...a, dryRun: false }),
  resume: (f) => f.resumeAdmission(),
  cleanup: (f, a) => f.cleanup(a),
  withdraw: (f, a) => f.withdraw(a.token, a.amount),
  import: (f, a) => f.importState(a.text),
}
const MUTATING = new Set(['deposit', 'commit', 'resume', 'cleanup', 'withdraw', 'import'])

/** Flows run as jobs: the page gets an id at once and follows `job:<id>` in storage.session (no event outlives 5 min). */
async function runJob(id, op, args) {
  const log = []
  const put = (rec) => session.set({ [`job:${id}`]: plain({ op, log, ...rec }) })
  // Extension API calls reset the idle timer: keeps the worker alive through wallet prompts and proving.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000)
  try {
    await ready
    const ctx = await context((line) => { log.push(line); put({ state: 'running' }) })
    const work = () => OPS[op](flows(ctx), args ?? {})
    const result = await (MUTATING.has(op) ? withLock(ctx, work) : work())
    if (op === 'export' && !(await session.get('key')).key) fail('private state was locked during export')
    await put({ state: 'done', result })
    if (op === 'export' && !await chrome.alarms.get('clear-exports')) chrome.alarms.create('clear-exports', { delayInMinutes: 1 })
  } catch (e) {
    await put({ state: 'failed', error: e.shortMessage ?? e.message })
  } finally {
    clearInterval(keepAlive)
    tick()
  }
}

// ---- quick calls (answered directly)

const CALLS = {
  async setup({ passphrase }) { await session.set({ key: await exportKey(await createVault(local, passphrase)) }); return { unlocked: true } },
  async unlock({ passphrase }) { await session.set({ key: await exportKey(await unlockVault(local, passphrase)) }); tick(); return { unlocked: true } },
  async lock() { await session.remove('key'); await clearExports(session); return { unlocked: false } },
  async session() {
    const [{ config, kdf }, s] = await Promise.all([local.get(['config', 'kdf']), session.get(['key', 'bridge', 'wallet', 'wallets', 'clock'])])
    return { hasPassphrase: !!kdf, unlocked: !!s.key, bridge: !!s.bridge, bridgeOrigin: BRIDGE_ORIGIN, wallet: s.wallet ?? null, wallets: s.wallets ?? [], clock: s.clock ?? null, config: config ?? null }
  },
  async config({ rpcUrl, deployment, drand }) {
    for (const k of ['chainId', 'vault', 'settlement']) if (deployment?.[k] == null) fail(`deployment has no "${k}"`)
    if (drand != null && (typeof drand.public_key !== 'string' || typeof drand.rounds !== 'object')) fail('drand must be a recorded-rounds fixture {public_key, chain_hash, rounds} or empty')
    await local.set({ config: { rpcUrl: rpcUrl || DEFAULT_RPC, deployment, drand: drand ?? null } })
    tick()
    return { saved: true }
  },
  async connect(selector) { bridge.connect(selector); return { requested: true } },
}

chrome.runtime.onMessage.addListener((m, sender, respond) => {
  if (sender.id !== chrome.runtime.id || m?.target === 'offscreen') return false
  if (m?.type === 'run' && OPS[m.op]) {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    runJob(id, m.op, m.args)
    respond({ ok: true, result: { job: id } })
    return false
  }
  if (m?.type !== 'call' || !CALLS[m.op]) return false
  ready.then(() => CALLS[m.op](m.args ?? {})).then((result) => respond({ ok: true, result: plain(result) }), (e) => respond({ ok: false, error: e.message }))
  return true
})

// ---- batch clock: wake at the next deadline of an open commitment; the badge counts steps that are due now

async function tick() {
  try {
    const ctx = await context()
    const saved = ctx.unlocked ? new Set((await ctx.store.load()).commitments.map((c) => c.hash)) : new Set()
    const { now, steps } = await flows(ctx).exitSteps(saved)
    const due = steps.filter((s) => s.action !== 'wait')
    const next = steps.filter((s) => s.action === 'wait').reduce((m, s) => (m == null || s.at < m ? s.at : m), null)
    await chrome.action.setBadgeText({ text: due.length ? String(due.length) : '' })
    await session.set({ clock: plain({ now, open: steps.length, due: due.map((s) => ({ id: s.c.id, action: s.action })), next }) })
    if (next != null) chrome.alarms.create('tick', { when: Date.now() + Number(next - now + 1n) * 1000 })
    else if (steps.length) chrome.alarms.create('tick', { delayInMinutes: 1 })
    else chrome.alarms.clear('tick')
  } catch {
    chrome.action.setBadgeText({ text: '' })
  }
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'tick') tick()
  if (a.name === 'clear-exports') clearExports(session)
})
chrome.runtime.onStartup.addListener(tick)
chrome.runtime.onInstalled.addListener(tick)
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: 'app.html' }))
