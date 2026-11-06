const output = document.querySelector('#output')
const state = document.querySelector('#job-state')
const reconnect = document.querySelector('#reconnect')
const jobKey = 'blindfold.localJob'
const mobile = matchMedia('(max-width: 760px) and (pointer: coarse)')
const desktopOnly = new Set(['prepare-admission', 'preflight', 'commit', 'deposit', 'cleanup', 'resume-admission', 'backup-import'])
let busy = false
const savedJob = () => { try { return sessionStorage.getItem(jobKey) } catch { return null } }
const saveJob = (id) => { try { if (id) sessionStorage.setItem(jobKey, id); else sessionStorage.removeItem(jobKey) } catch {} }
function setBusy(value) {
  busy = value
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
      if (job.state !== 'running') {
        if (job.state === 'done' && job.action === 'backup-export' && typeof job.backup === 'string') {
          const url = URL.createObjectURL(new Blob([job.backup], { type: 'application/json' }))
          const link = document.createElement('a'); link.href = url; link.download = 'blindfold-backup.json'; link.click()
          setTimeout(() => URL.revokeObjectURL(url), 10000)
          output.textContent = 'Backup downloaded. Keep it private and store it somewhere safe.'
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
    await follow(data.id)
  } catch (e) { output.textContent = e.message; state.textContent = 'FAILED' }
  finally { setBusy(false) }
}
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
