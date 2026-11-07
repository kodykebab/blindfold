// Browser-wallet inspection only. This module never requests a signature or sends a transaction.
const address = (s) => typeof s === 'string' && /^0x[0-9a-f]{40}$/i.test(s)
const chain = (s) => typeof s === 'string' && /^0x[0-9a-f]+$/i.test(s)
export function createWalletView(win, notify) {
  const entries = new Map()
  let current = null, generation = 0
  const publish = () => notify({ wallets: [...entries.values()].map(({ id, name }) => ({ id, name })),
    selected: current ? { id: current.id, name: current.name, account: current.account, chainId: current.chainId } : null })
  function add(id, name, provider) {
    if (!id || typeof provider?.request !== 'function' || entries.has(id) || [...entries.values()].some((e) => e.provider === provider)) return
    entries.set(id, { id, name: String(name || 'Browser wallet').slice(0, 80), provider }); publish()
  }
  const announced = (event) => {
    const info = event.detail?.info
    if (typeof info?.uuid !== 'string' || info.uuid.length > 256) return
    add(info.uuid, info.name, event.detail?.provider)
  }
  function detach() {
    if (!current) return
    for (const [event, handler] of current.listeners) current.provider.removeListener?.(event, handler)
    current = null
  }
  async function refresh(entry, requestAccounts = false) {
    const seq = ++generation
    const accounts = await entry.provider.request({ method: requestAccounts ? 'eth_requestAccounts' : 'eth_accounts' })
    const chainId = await entry.provider.request({ method: 'eth_chainId' })
    if (seq !== generation) return
    if (!Array.isArray(accounts) || !address(accounts[0]) || !chain(chainId)) { detach(); publish(); return }
    if (!current || current.id !== entry.id) {
      detach()
      const changed = () => { void refresh(entry).catch(() => { if (current?.id === entry.id) { generation++; detach(); publish() } }) }
      const listeners = ['accountsChanged', 'chainChanged', 'disconnect'].map((event) => [event, changed])
      current = { ...entry, listeners }
      for (const [event, handler] of listeners) entry.provider.on?.(event, handler)
    }
    current.account = accounts[0]; current.chainId = chainId; publish()
  }
  win.addEventListener('eip6963:announceProvider', announced)
  win.dispatchEvent(new Event('eip6963:requestProvider'))
  if (win.ethereum) add('injected', 'Browser wallet', win.ethereum)
  publish()
  return {
    async connect(id) { const entry = entries.get(id); if (!entry) throw Error('Browser wallet not available'); await refresh(entry, true) },
    disconnect() { generation++; detach(); publish() },
    close() { generation++; detach(); win.removeEventListener('eip6963:announceProvider', announced) },
  }
}

export function walletMismatch(wallet, status) {
  if (!wallet) return null
  if (!status?.account || !/^network \d+$/.test(status.network ?? '')) return 'Load CLI account status before trading.'
  if (wallet.account.toLowerCase() !== status.account.toLowerCase()) return 'Browser wallet and CLI account differ. Disconnect or select the same account.'
  if (BigInt(wallet.chainId) !== BigInt(status.network.slice(8))) return 'Browser wallet and CLI network differ. Switch networks or disconnect.'
  return null
}
