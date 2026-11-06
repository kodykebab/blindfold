// Bridge page: connects the Blindfold extension's port to the wallet the user picks. Renders from the messages it sends.
import { discover } from './wallet.mjs'
import { createBridge } from './protocol.mjs'
import { EXTENSION_ID } from './config.mjs'

const $ = (id) => document.getElementById(id)
const show = (id, text) => { $(id).textContent = text }
let port = null
const queue = [] // `sent` / `result` produced while the port was down; delivered after the next hello

function deliver(m) {
  render(m)
  try {
    port.postMessage(m)
  } catch {
    if (m.id) queue.push(m)
  }
}

function render(m) {
  if (m.type === 'wallets') {
    $('wallets').replaceChildren(...m.wallets.map((w) => {
      const b = document.createElement('button')
      if (w.icon) b.append(Object.assign(document.createElement('img'), { src: w.icon, alt: '' }))
      b.append(w.name || w.rdns)
      b.dataset.rdns = w.rdns
      b.onclick = () => bridge.onMessage({ type: 'connect', uuid: w.uuid })
      return b
    }))
    show('no-wallet', m.wallets.length ? '' : 'No wallet found yet. Install or unlock one, then reload.')
  }
  if (m.type === 'wallet') {
    show('account', m.accounts[0] ?? 'not connected')
    show('chain', m.chainId ? String(BigInt(m.chainId)) : '-')
    show('batching', m.atomic ? 'one signature per batch (EIP-5792)' : 'one signature per transaction')
  }
  if (m.type === 'sent') show('activity', `Sent ${m.hash ?? m.callsId}; waiting for it to be mined...`)
  if (m.type === 'result') show('activity', m.ok ? `Done: ${m.hashes.length} transaction(s) mined.` : `Failed: ${m.error.code} ${m.error.message}`)
  if (m.type === 'error') show('activity', `Error: ${m.error.code} ${m.error.message}`)
}

const bridge = createBridge({ post: deliver })
discover(window, (w) => bridge.add(w))

function connectPort() {
  if (!globalThis.chrome?.runtime?.connect) return show('extension', 'Blindfold extension not found: install or enable it, then reload this page.')
  port = chrome.runtime.connect(EXTENSION_ID, { name: 'blindfold-bridge' })
  let replaced = false
  port.onMessage.addListener((m) => {
    if (m?.type === 'replaced') return void (replaced = true)
    if (m?.type === 'send') show('activity', `Confirm ${m.calls?.length ?? 0} transaction(s) in your wallet...`)
    bridge.onMessage(m)
  })
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError
    port = null
    // reconnecting here would take the port back from the newer tab, which would then take it back, forever
    if (replaced) return show('extension', 'Blindfold is using a bridge page in another tab. Reload this page to use this one instead.')
    show('extension', 'Extension disconnected; reconnecting...')
    setTimeout(connectPort, 1000)
  })
  show('extension', 'Connected to the Blindfold extension.')
  bridge.sync()
  for (const m of queue.splice(0)) deliver(m)
}

// A message every 25 s keeps the extension's service worker alive while a wallet prompt is open.
setInterval(() => { try { port?.postMessage({ type: 'ping' }) } catch {} }, 25_000)
connectPort()
