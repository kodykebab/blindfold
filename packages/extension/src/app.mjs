// The extension page: a thin client of the service worker (extension-team/INTERFACES.md, "Pages <-> service worker").
const $ = (id) => document.getElementById(id)
const out = $('out')
const print = (x) => { out.textContent = typeof x === 'string' ? x : JSON.stringify(x, null, 2) }

async function call(op, args) {
  const r = await chrome.runtime.sendMessage({ type: 'call', op, args })
  if (!r?.ok) throw new Error(r?.error ?? 'no answer from the service worker')
  return r.result
}

/** Start a flow and follow its job record until it is done or failed; progress lines print as they arrive. */
async function run(op, args) {
  const r = await chrome.runtime.sendMessage({ type: 'run', op, args })
  if (!r?.ok) throw new Error(r?.error ?? `unknown operation ${op}`)
  const key = `job:${r.result.job}`
  return new Promise((resolve, reject) => {
    const seen = (rec) => {
      if (!rec) return
      if (rec.state === 'running') return print(`${op}…\n${rec.log.join('\n')}`)
      chrome.storage.onChanged.removeListener(listener)
      chrome.storage.session.remove(key) // results may hold an export: drop them once read
      rec.state === 'done' ? resolve(rec.result) : reject(new Error([...rec.log, rec.error].join('\n')))
    }
    const listener = (changes, area) => { if (area === 'session' && changes[key]) seen(changes[key].newValue) }
    chrome.storage.onChanged.addListener(listener)
    chrome.storage.session.get(key).then((r) => seen(r[key]))
  })
}

const ARGS = {
  unlock: () => ({ passphrase: $('passphrase').value }),
  setup: () => ({ passphrase: $('passphrase').value }),
  config: () => ({ rpcUrl: $('rpc-url').value.trim(), deployment: JSON.parse($('deployment').value || 'null'), drand: $('drand').value.trim() ? JSON.parse($('drand').value) : null }),
  deposit: () => ({ token: $('deposit-token').value, amount: $('deposit-amount').value.trim() }),
  preflight: () => ({ side: $('side').value, amountIn: $('amount-in').value.trim(), minOut: $('min-out').value.trim() }),
  commit: () => ({ side: $('side').value, amountIn: $('amount-in').value.trim(), minOut: $('min-out').value.trim() }),
  cleanup: () => ({ dryRun: $('cleanup-dry').checked }),
  withdraw: () => ({ token: $('withdraw-token').value, amount: $('withdraw-amount').value.trim() || 'all' }),
}

function download(text) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: `blindfold-state-${Date.now()}.json` })
  a.click()
  URL.revokeObjectURL(a.href)
}

async function act(button) {
  const op = button.dataset.call ?? button.dataset.run
  button.disabled = true
  try {
    const args = ARGS[op]?.()
    const result = button.dataset.call ? await call(op, args) : await run(op, args)
    if (op === 'export') { download(result); print('exported: keep the file private') } else print(result)
    if (op === 'unlock' || op === 'setup') $('passphrase').value = ''
  } catch (e) { print(`${op} failed: ${e.message}`) }
  finally { button.disabled = false; refresh() }
}

async function refresh() {
  const s = await call('session')
  $('bridge-link').href = `${s.bridgeOrigin}/`
  $('session').textContent = [
    s.unlocked ? 'unlocked' : s.hasPassphrase ? 'locked' : 'no passphrase yet',
    s.bridge ? 'bridge connected' : 'bridge not connected',
    s.wallet?.accounts?.[0] ? `account ${s.wallet.accounts[0]} on chain ${parseInt(s.wallet.chainId, 16)}` : 'no wallet account',
    s.clock ? `${s.clock.open} open commitment(s), ${s.clock.due.length} step(s) due` : '',
  ].filter(Boolean).join(' · ')
  $('wallets').replaceChildren(...s.wallets.map((w) => {
    const b = Object.assign(document.createElement('button'), { textContent: `Connect ${w.name}` })
    b.onclick = () => call('connect', { uuid: w.uuid }).catch((e) => print(e.message))
    return b
  }))
  if (s.config && !$('deployment').value) {
    $('rpc-url').value = s.config.rpcUrl ?? ''
    $('deployment').value = JSON.stringify(s.config.deployment, null, 2)
    if (s.config.drand) $('drand').value = JSON.stringify(s.config.drand)
  }
}

document.querySelectorAll('button[data-call], button[data-run]').forEach((b) => { b.onclick = () => act(b) })
$('import-file').onchange = async (e) => {
  const file = e.target.files[0]
  if (!file) return
  try { print(await run('import', { text: await file.text() })) } catch (err) { print(`import failed: ${err.message}`) }
  e.target.value = ''
}
chrome.storage.onChanged.addListener((_, area) => { if (area === 'session') refresh().catch(() => {}) })
refresh().catch((e) => print(e.message))
