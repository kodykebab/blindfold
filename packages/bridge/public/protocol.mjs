// Bridge side of the extension <-> bridge protocol (extension-team/INTERFACES.md, "Extension <-> bridge page").
// Pure logic: the page supplies `post` (to the extension port) and feeds wallets in with add().
import { atomicSupport, ensureChain, fail, sendCalls } from './wallet.mjs'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const QUANTITY = /^0x(0|[1-9a-fA-F][0-9a-fA-F]*)$/
const DATA = /^0x([0-9a-fA-F]{2})*$/
const MAX_DATA = 2 + 2 * 128 * 1024 // 128 KiB: the default txpool size limit
const MAX_CALLS = 8

/** Validate a `send` and keep only the fields the wallet should see; throws BAD_REQUEST. */
export function parseSend(m) {
  const bad = (what) => { throw fail('BAD_REQUEST', `send: invalid ${what}`) }
  if (!ADDRESS.test(m.from ?? '')) bad('from')
  const ch = m.chain ?? {}, cur = ch.nativeCurrency ?? {}
  if (!QUANTITY.test(ch.chainId ?? '') || typeof ch.chainName !== 'string' || !Array.isArray(ch.rpcUrls) || !ch.rpcUrls.length
    || !ch.rpcUrls.every((u) => typeof u === 'string') || typeof cur.name !== 'string' || typeof cur.symbol !== 'string'
    || !Number.isInteger(cur.decimals)) bad('chain')
  if (!Array.isArray(m.calls) || m.calls.length < 1 || m.calls.length > MAX_CALLS) bad('calls')
  const calls = m.calls.map((c) => {
    if (!ADDRESS.test(c?.to ?? '') || typeof c.data !== 'string' || c.data.length > MAX_DATA || !DATA.test(c.data)
      || (c.value != null && !QUANTITY.test(c.value))) bad('call')
    return c.value == null ? { to: c.to, data: c.data } : { to: c.to, data: c.data, value: c.value }
  })
  const chain = { chainId: ch.chainId.toLowerCase(), chainName: ch.chainName, rpcUrls: ch.rpcUrls, nativeCurrency: { name: cur.name, symbol: cur.symbol, decimals: cur.decimals } }
  return { from: m.from, chain, calls }
}

const errorOf = (e) => ({ code: e?.code ?? 'INTERNAL', message: String(e?.message ?? e) })

/** opts: {interval, timeout} for receipt polling (tests shorten them). */
export function createBridge({ post, opts = {} }) {
  const wallets = []
  let current = null // { entry, accounts, chainId, atomic, off }
  let busy = false
  let seq = 0

  const walletMsg = () => {
    const { uuid, name, rdns } = current.entry.info
    return { type: 'wallet', uuid, name, rdns, accounts: current.accounts, chainId: current.chainId, atomic: current.atomic }
  }

  // Re-read accounts, chain and batch support; only the latest refresh posts, so a slow one can't post stale state.
  async function refresh() {
    const n = ++seq, c = current, p = c.entry.provider
    try {
      const accounts = await p.request({ method: 'eth_accounts' })
      const chainId = await p.request({ method: 'eth_chainId' })
      const atomic = accounts[0] ? await atomicSupport(p, accounts[0], chainId) : false
      if (n !== seq || c !== current) return
      Object.assign(c, { accounts, chainId, atomic })
    } catch {
      if (n !== seq || c !== current) return
      Object.assign(c, { accounts: [], atomic: false })
    }
    post(walletMsg())
  }

  async function connect(entry) {
    const p = entry.provider
    await p.request({ method: 'eth_requestAccounts' })
    current?.off()
    const changed = () => { if (current?.entry === entry) refresh() }
    const events = ['accountsChanged', 'chainChanged', 'disconnect']
    for (const e of events) p.on?.(e, changed)
    current = { entry, accounts: [], chainId: null, atomic: false, off: () => events.forEach((e) => p.removeListener?.(e, changed)) }
    await refresh()
  }

  async function send(m) {
    const result = (r) => post({ type: 'result', id: m.id, ...r })
    if (busy) return result({ ok: false, error: fail('BUSY', 'another request is in progress'), hashes: [], receipts: [] })
    busy = true
    try {
      const req = parseSend(m)
      const p = current?.entry.provider
      if (!p) throw fail('NO_WALLET', 'no wallet connected')
      const [account] = await p.request({ method: 'eth_accounts' })
      if (account?.toLowerCase() !== req.from.toLowerCase()) throw fail('WRONG_ACCOUNT', `wallet account is ${account ?? 'none'}, request is for ${req.from}`)
      await ensureChain(p, req.chain)
      const chainId = req.chain.chainId
      const atomic = req.calls.length > 1 && await atomicSupport(p, req.from, chainId)
      const r = await sendCalls(p, { from: req.from, chainId, calls: req.calls, atomic }, { ...opts, onSent: (s) => post({ type: 'sent', id: m.id, ...s }) })
      result({ ok: true, ...r })
    } catch (e) {
      result({ ok: false, error: errorOf(e), hashes: e?.hashes ?? [], receipts: e?.receipts ?? [] })
    } finally {
      busy = false
    }
  }

  return {
    /** A discovered wallet ({info, provider}); tells the extension the new list. */
    add(entry) {
      wallets.push(entry)
      post({ type: 'wallets', wallets: wallets.map((w) => w.info) })
    },
    /** After every (re)connect of the extension port. */
    sync() {
      post({ type: 'hello', version: 1 })
      post({ type: 'wallets', wallets: wallets.map((w) => w.info) })
      if (current) post(walletMsg())
    },
    /** A message from the extension (or the page UI, for `connect`). */
    async onMessage(m) {
      try {
        if (m?.type === 'connect') {
          const entry = wallets.find((w) => (m.uuid && w.info.uuid === m.uuid) || (m.rdns && w.info.rdns === m.rdns))
          if (!entry) throw fail('NO_WALLET', `no wallet ${m.uuid ?? m.rdns}`)
          return await connect(entry)
        }
        if (m?.type === 'send' && typeof m.id === 'string' && m.id.length >= 1 && m.id.length <= 64) return await send(m)
        throw fail('BAD_REQUEST', m?.type === 'send' ? 'send: invalid id' : `unknown message type ${m?.type}`)
      } catch (e) {
        post({ type: 'error', error: errorOf(e) })
      }
    },
  }
}
