import { jobStage, parseBlockers, parseStatus, parseTrack, preparedBatch } from './status.mjs'
import { createBackupReminder, createJobStore } from './job-store.mjs'
import { createWalletView, walletMismatch } from './wallet-view.mjs'
const output = document.querySelector('#output')
const state = document.querySelector('#job-state')
const reconnect = document.querySelector('#reconnect')
const reminder = document.querySelector('#backup-reminder')
const reminderStore = (() => { try { return createBackupReminder(localStorage) } catch { return createBackupReminder(null) } })()
function showBackupReminder(show) { reminder.hidden = !show; reminderStore.set(show) }
reminder.hidden = !reminderStore.get()
const jobStore = (() => { try { return createJobStore(localStorage) } catch { return createJobStore(null) } })()
const mobile = matchMedia('(max-width: 760px) and (pointer: coarse)')
const desktopOnly = new Set(['prepare-admission', 'preflight', 'commit', 'deposit', 'cleanup', 'resume-admission', 'backup-import'])
let busy = false, lastStatus = null, walletState = { wallets: [], selected: null }
const savedJob = () => jobStore.get()
const saveJob = (id) => jobStore.set(id)
function setBusy(value) {
  busy = value
  document.querySelector('#job-progress').hidden = !value
  const mismatch = walletMismatch(walletState.selected, lastStatus)
  document.querySelectorAll('button, input, select').forEach((control) => { control.disabled = value || (mobile.matches && Boolean(control.closest('[data-desktop-only]'))) || (Boolean(mismatch) && Boolean(control.closest('[data-wallet-guard]'))) })
  document.querySelector('#wallet-choice').disabled = value || !walletState.wallets.length
  document.querySelector('#wallet-connect').disabled = value || !walletState.wallets.length

}
async function follow(id) {
  setBusy(true); reconnect.hidden = true; state.textContent = 'RUNNING'
  try {
    while (true) {
      const result = await fetch(`/api/trade/${encodeURIComponent(id)}`, { cache: 'no-store' })
      const job = await result.json()
      if (!result.ok) {
        if (result.status === 404) saveJob(null)
        throw Error(result.status === 404 ? 'The local service no longer has this command. Check your state and use Resume admission if a submission was interrupted.' : job.error || 'Could not read command')
      }
      output.textContent = job.output || 'The local client is working…'
      if (job.state === 'running') state.textContent = jobStage(job)
      if (job.state !== 'running') {
        if (job.state === 'done' && job.action === 'status') showStatus(job.output)
        if (job.state === 'done' && job.action === 'track') showOrders(job.output)
        if (job.state === 'done' && ['blockers', 'cleanup-preview'].includes(job.action)) showBlockers(job.output)
        if (job.state === 'done' && job.action === 'prepare-admission') {
          const prepared = preparedBatch(job.output)
          if (prepared !== null) document.querySelector('#preparation-state').textContent = `Prepared for batch ${prepared}. Refresh status before submitting.`
        }
        if (job.state === 'done' && job.action === 'backup-export' && typeof job.backup === 'string') {
          const url = URL.createObjectURL(new Blob([job.backup], { type: 'application/json' }))
          const link = document.createElement('a'); link.href = url; link.download = 'blindfold-backup.json'; link.click()
          setTimeout(() => URL.revokeObjectURL(url), 10000)
          output.textContent = 'A backup download was requested. Save it somewhere private, then mark it saved.'
        } else if (job.state === 'done' && job.action === 'commit') {
          output.textContent += '\n\nBack up your private state using Export backup below.'
        }
        saveJob(null); state.textContent = job.state === 'done' ? 'COMPLETE' : 'FAILED'; break
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  } catch (e) {
    output.textContent = `${e.message}\n\nThe command may still be running on this machine.`
    state.textContent = 'DISCONNECTED'; reconnect.hidden = !savedJob()
  } finally { setBusy(false) }
}
async function run(input) {
  if (busy) return
  if (savedJob()) { await follow(savedJob()); return }
  const guarded = new Set(['prepare-admission', 'preflight', 'commit', 'deposit', 'withdraw', 'cleanup', 'resume-admission', 'backup-export', 'backup-import'])
  const mismatch = walletMismatch(walletState.selected, lastStatus)
  if (mismatch && guarded.has(input.action)) { output.textContent = mismatch; state.textContent = 'ACCOUNT CHECK'; return }
  if (mobile.matches && desktopOnly.has(input.action)) { output.textContent = 'Use a desktop to run this action.'; state.textContent = 'DESKTOP ONLY'; return }
  setBusy(true); state.textContent = 'STARTING'; output.textContent = `Starting ${input.action} through the local client…`
  try {
    const response = await fetch('/api/trade', { method: 'POST', headers: { 'content-type': 'application/json', 'x-blindfold-request': '1' }, body: JSON.stringify(input) })
    const data = await response.json()
    if (!response.ok) throw Error(data.error || 'Could not start command')
    saveJob(data.id)
    if (input.action === 'commit') {
      showBackupReminder(true)
      document.querySelector('#preparation-state').textContent = 'Submission may consume the prepared key. Refresh status before the next order.'
    }
    await follow(data.id)
  } catch (e) { output.textContent = e.message; state.textContent = 'FAILED' }
  finally { setBusy(false) }
}
function showBlockers(text) {
  const rows = parseBlockers(text)
  if (rows === null) return
  const list = document.querySelector('#blocker-list'); list.replaceChildren()
  document.querySelector('#blockers-message').textContent = rows.length ? 'These commitments are holding withdrawals.' : 'No commitments currently block withdrawal.'
  for (const row of rows) {
    const item = document.createElement('li')
    const title = document.createElement('strong'); title.textContent = `Order #${row.id} · batch ${row.batch}`
    const action = document.createElement('span'); action.className = 'order-state'; action.textContent = row.action
    const reason = document.createElement('p'); reason.textContent = row.reason
    item.append(title, action, reason); list.append(item)
  }
}
function showOrders(text) {
  const rows = parseTrack(text)
  if (rows === null) return
  const list = document.querySelector('#order-list'); list.replaceChildren()
  document.querySelector('#orders-message').textContent = rows.length ? 'Latest status from the settlement contract.' : 'No commitments found for this account.'
  for (const row of rows) {
    const item = document.createElement('li')
    const title = document.createElement('strong'); title.textContent = `Order #${row.id} · batch ${row.batch}`
    const state = document.createElement('span'); state.className = 'order-state'; state.textContent = row.state
    const detail = document.createElement('p'); detail.textContent = row.detail
    item.append(title, state, detail); list.append(item)
  }
}
function showStatus(text) {
  const parsed = parseStatus(text)
  if (!parsed) return
  lastStatus = parsed
  renderWallet(walletState)
  document.querySelector('#account-address').textContent = parsed.account
  document.querySelector('#network-pair').textContent = [parsed.network, parsed.pair].filter(Boolean).join(' · ') || 'Network and pair not reported'
  document.querySelector('#batch-status').textContent = parsed.batch
  document.querySelector('#preparation-state').textContent = parsed.preparation ?? 'Preparation is not required by this deployment'
  const current = parsed.batch.match(/^batch (\d+) /)
  const batchInput = document.querySelector('#prepare input[name=batch]')
  if (!batchInput.value && current && BigInt(current[1]) + 1n < (1n << 64n)) batchInput.value = String(BigInt(current[1]) + 1n)
  document.querySelector('#open-status').textContent = parsed.open
  const rows = document.querySelector('#balance-rows'); rows.replaceChildren()
  for (const row of parsed.rows) {
    const section = document.createElement('div'); section.className = 'balance-row'
    const token = document.createElement('strong'); token.textContent = row.token; section.append(token)
    for (const [name, value] of [['Wallet', row.wallet], ['Available', row.available], ['Reserved', row.reserved], ['Withdrawable', row.withdrawable]]) {
      const item = document.createElement('span'); item.textContent = `${name}: ${value}`; section.append(item)
    }
    rows.append(section)
  }
  document.querySelector('#deadlines').textContent = parsed.deadlines.join(' · ')
  document.querySelector('#balances').hidden = false
}
document.querySelector('#backup-confirm').addEventListener('click', () => showBackupReminder(false))
const order = document.querySelector('#order')
function orderAction(action) {
  if (!order.reportValidity()) return
  const data = new FormData(order)
  run({ action, side: data.get('side'), amount: data.get('amount'), minimum: data.get('minimum') })
}
document.querySelector('#preview').addEventListener('click', () => orderAction('preflight'))
order.addEventListener('submit', (event) => { event.preventDefault(); orderAction('commit') })
document.querySelector('#prepare').addEventListener('submit', (event) => { event.preventDefault(); run({ action: 'prepare-admission', batch: new FormData(event.currentTarget).get('batch') }) })
document.querySelector('#funds').addEventListener('submit', (event) => {
  event.preventDefault()
  const data = new FormData(event.currentTarget)
  run({ action: event.submitter.value, token: data.get('token'), amount: data.get('amount') })
})
document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => run({ action: button.dataset.action })))
reconnect.addEventListener('click', () => { const id = savedJob(); if (id) follow(id) })
function renderWallet(value) {
  walletState = value
  const select = document.querySelector('#wallet-choice'), previous = select.value
  select.replaceChildren()
  if (!value.wallets.length) { const option = document.createElement('option'); option.value = ''; option.textContent = 'No browser wallet detected'; select.append(option) }
  for (const wallet of value.wallets) { const option = document.createElement('option'); option.value = wallet.id; option.textContent = wallet.name; select.append(option) }
  if (value.wallets.some((wallet) => wallet.id === previous)) select.value = previous
  const selected = value.selected, mismatch = walletMismatch(selected, lastStatus)
  document.querySelector('#wallet-message').textContent = selected
    ? `${selected.name}: ${selected.account} · chain ${BigInt(selected.chainId)}. ${mismatch ?? 'Account and network match.'} Read-only: the CLI signs transactions; the browser wallet does not.`
    : 'The CLI signs transactions with its configured account. Browser wallets do not sign in this version.'
  document.querySelector('#wallet-disconnect').hidden = !selected
  setBusy(busy)
}
const walletView = createWalletView(window, renderWallet)
document.querySelector('#wallet-connect').addEventListener('click', async () => {
  try { await walletView.connect(document.querySelector('#wallet-choice').value) }
  catch (e) { document.querySelector('#wallet-message').textContent = `Could not view wallet: ${e.message}` }
})
document.querySelector('#wallet-disconnect').addEventListener('click', () => walletView.disconnect())
mobile.addEventListener('change', () => setBusy(busy))
setBusy(false)
if (savedJob()) follow(savedJob())

document.querySelector('#restore-file').addEventListener('change', async (event) => {
  const file = event.currentTarget.files[0]
  if (!file) return
  try {
    if (file.size > 1_000_000) throw Error('Backup is too large')
    await run({ action: 'backup-import', backup: await file.text() })
  } catch (e) { output.textContent = e.message; state.textContent = 'FAILED' }
  finally { event.currentTarget.value = '' }
})
