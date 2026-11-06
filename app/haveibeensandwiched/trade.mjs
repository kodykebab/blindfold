import { jobStage, parseStatus, preparedBatch } from './status.mjs'
import { createBackupReminder, createJobStore } from './job-store.mjs'
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
let busy = false
const savedJob = () => jobStore.get()
const saveJob = (id) => jobStore.set(id)
function setBusy(value) {
  busy = value
  document.querySelector('#job-progress').hidden = !value
  document.querySelectorAll('button, input, select').forEach((control) => { control.disabled = value || (mobile.matches && Boolean(control.closest('[data-desktop-only]'))) })
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
  if (mobile.matches && desktopOnly.has(input.action)) { output.textContent = 'Use a desktop to run this action.'; state.textContent = 'DESKTOP ONLY'; return }
  if (savedJob()) { await follow(savedJob()); return }
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
function showStatus(text) {
  const parsed = parseStatus(text)
  if (!parsed) return
  document.querySelector('#account-address').textContent = parsed.account
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
