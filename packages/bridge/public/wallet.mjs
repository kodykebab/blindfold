// EIP-1193 wallet adapter: EIP-6963 discovery, chain checks, EIP-5792 batches with a one-by-one fallback.
// Runs in the bridge page and in Node tests (no DOM beyond EventTarget).

// Wallet answers to wallet_sendCalls meaning "I can't batch this", so nothing was sent and one-by-one is safe.
const NO_BATCH = new Set([4200, -32601, 5700, 5710, 5740, 5750, 5760])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A plain {code, message} error; `hashes`/`receipts` say what was sent before it happened. */
export const fail = (code, message, extra = {}) => ({ code, message, ...extra })

/**
 * EIP-6963 discovery on `win`: calls onAdd({info, provider}) once per new wallet. A legacy `win.ethereum` is
 * added only if nobody announced within `legacyAfter` ms.
 */
export function discover(win, onAdd, { legacyAfter = 500 } = {}) {
  const seen = new Set()
  const add = (info, provider) => {
    if (!info?.uuid || typeof provider?.request !== 'function' || seen.has(String(info.uuid))) return
    seen.add(String(info.uuid))
    const icon = String(info.icon ?? '')
    onAdd({
      info: { uuid: String(info.uuid), name: String(info.name ?? ''), icon: icon.startsWith('data:image/') ? icon : '', rdns: String(info.rdns ?? '') },
      provider,
    })
  }
  win.addEventListener('eip6963:announceProvider', (e) => add(e.detail?.info, e.detail?.provider))
  win.dispatchEvent(new Event('eip6963:requestProvider'))
  setTimeout(() => {
    if (!seen.size && win.ethereum) add({ uuid: 'injected', name: 'Browser wallet', icon: '', rdns: 'injected' }, win.ethereum)
  }, legacyAfter)
}

/** Does the wallet batch atomically for `account` on `chainId` (EIP-5792 v2 `atomic`, or v1 `atomicBatch`)? */
export async function atomicSupport(provider, account, chainId) {
  try {
    const caps = await provider.request({ method: 'wallet_getCapabilities', params: [account, [chainId]] })
    const c = caps?.[chainId] ?? caps?.['0x0']
    return ['supported', 'ready'].includes(c?.atomic?.status) || c?.atomicBatch?.supported === true
  } catch {
    return false
  }
}

/** Put the wallet on `chain` (switch, or add on 4902), or throw before anything is signed. */
export async function ensureChain(provider, chain) {
  const on = async () => BigInt(await provider.request({ method: 'eth_chainId' })) === BigInt(chain.chainId)
  if (await on()) return
  const switchChain = () => provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.chainId }] })
  try {
    await switchChain()
  } catch (e) {
    if (e?.code !== 4902 && e?.data?.originalError?.code !== 4902) throw e
    await provider.request({ method: 'wallet_addEthereumChain', params: [chain] })
    await switchChain() // some wallets add without switching
  }
  if (!(await on())) throw fail('WRONG_CHAIN', `wallet is not on chain ${chain.chainId}`)
}

/**
 * Before anything is signed: can `from` pay gas and value for `call`? Returns {need, balance} when it can't, null when
 * it can or when the wallet can't answer (it then reports the problem itself). Later calls may depend on earlier ones
 * (approve, then deposit), so only the first is estimated.
 */
export async function fundsShortfall(provider, from, call) {
  try {
    const [balance, gasPrice, gas] = await Promise.all([
      provider.request({ method: 'eth_getBalance', params: [from, 'latest'] }),
      provider.request({ method: 'eth_gasPrice' }),
      provider.request({ method: 'eth_estimateGas', params: [{ from, ...call }] }),
    ]).then((v) => v.map(BigInt))
    const need = gas * gasPrice + BigInt(call.value ?? 0)
    return balance < need ? { need: String(need), balance: String(balance) } : null
  } catch {
    return null
  }
}

async function poll(fn, done, { interval, timeout }) {
  for (const end = Date.now() + timeout; ;) {
    const v = await fn()
    if (done(v)) return v
    if (Date.now() > end) throw fail('TIMEOUT', `nothing final after ${timeout} ms`)
    await sleep(interval)
  }
}

/**
 * Send `calls` from `from` and wait until mined. Atomic (wallet_sendCalls) when `atomic` and there is more than
 * one call, else one eth_sendTransaction at a time, each mined before the next. Resolves {atomic, hashes, receipts};
 * rejects with {code, message, hashes, receipts}. onSent({index, hash}) or onSent({callsId}) fires as soon as the
 * wallet accepts, before inclusion.
 */
export async function sendCalls(provider, { from, chainId, calls, atomic }, { interval = 1000, timeout = 600_000, onSent = () => {} } = {}) {
  const hashes = [], receipts = []
  const wrap = (e) => {
    const message = e?.message ?? String(e)
    if (e?.code !== 'INSUFFICIENT_FUNDS' && /insufficient funds/i.test(message + (e?.data?.message ?? ''))) {
      return { ...fail('INSUFFICIENT_FUNDS', `not enough ETH on ${from} for gas and value; add ETH and try again (${message})`), hashes, receipts }
    }
    return { ...fail(e?.code ?? 'INTERNAL', message), hashes, receipts }
  }
  const short = await fundsShortfall(provider, from, calls[0])
  if (short) throw wrap(fail('INSUFFICIENT_FUNDS', `not enough ETH on ${from}: the first transaction needs about ${short.need} wei for gas and value, the account has ${short.balance} wei; add ETH and try again`))
  if (atomic && calls.length > 1) {
    let id, unsupported = false
    try {
      const r = await provider.request({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId, from, atomicRequired: true, calls }] })
      id = typeof r === 'string' ? r : r?.id
    } catch (e) {
      if (!NO_BATCH.has(e?.code)) throw wrap(e)
      unsupported = true
    }
    // A successful response without an ID is ambiguous: the wallet may already have submitted the batch.
    // Never retry those calls individually, since that could execute them twice.
    if (!unsupported && (typeof id !== 'string' || !id.trim())) {
      throw wrap(fail('UNKNOWN_OUTCOME', 'wallet accepted the batch request but returned no usable ID; check the wallet before retrying'))
    }
    if (!unsupported) {
      try {
        onSent({ callsId: id })
        const s = await poll(() => provider.request({ method: 'wallet_getCallsStatus', params: [id] }),
          (s) => s?.status >= 200 || s?.status === 'CONFIRMED', { interval, timeout })
        receipts.push(...(s.receipts ?? []))
        hashes.push(...receipts.map((r) => r.transactionHash))
        const ok = (s.status === 200 || s.status === 'CONFIRMED') && receipts.length > 0 && receipts.every((r) => r.status === '0x1')
        if (!ok) throw fail('REVERTED', `batch ${id} failed (status ${s.status})`)
        return { atomic: true, hashes, receipts }
      } catch (e) {
        throw wrap(e)
      }
    }
  }
  try {
    for (const [index, c] of calls.entries()) {
      const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from, chainId, ...c }] })
      hashes.push(hash)
      onSent({ index, hash })
      const r = await poll(() => provider.request({ method: 'eth_getTransactionReceipt', params: [hash] }), Boolean, { interval, timeout })
      receipts.push(r)
      if (r.status !== '0x1') throw fail('REVERTED', `call ${index} reverted in ${hash}`)
    }
  } catch (e) {
    throw wrap(e)
  }
  return { atomic: false, hashes, receipts }
}
