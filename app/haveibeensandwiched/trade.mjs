const output = document.querySelector('#output')
const state = document.querySelector('#job-state')
let busy = false
async function run(input) {
  if (busy) return
  busy = true
  document.querySelectorAll('button').forEach((b) => { b.disabled = true })
  state.textContent = 'RUNNING'
  output.textContent = `Running ${input.action} through the local client…`
  try {
    const response = await fetch('/api/trade', { method: 'POST', headers: { 'content-type': 'application/json', 'x-blindfold-request': '1' }, body: JSON.stringify(input) })
    const data = await response.json()
    if (!response.ok) throw Error(data.error || 'Could not start command')
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const result = await fetch(`/api/trade/${encodeURIComponent(data.id)}`, { cache: 'no-store' })
      const job = await result.json()
      if (!result.ok) throw Error(job.error || 'Could not read command')
      output.textContent = job.output || `Running ${input.action} through the local client…`
      if (job.state !== 'running') { state.textContent = job.state === 'done' ? 'COMPLETE' : 'FAILED'; break }
    }
  } catch (e) { output.textContent = e.message; state.textContent = 'FAILED' }
  finally { busy = false; document.querySelectorAll('button').forEach((b) => { b.disabled = false }) }
}
const order = document.querySelector('#order')
function orderAction(action) {
  if (!order.reportValidity()) return
  const data = new FormData(order)
  run({ action, side: data.get('side'), amount: data.get('amount'), minimum: data.get('minimum') })
}
document.querySelector('#preview').addEventListener('click', () => orderAction('preflight'))
order.addEventListener('submit', (event) => { event.preventDefault(); orderAction('commit') })
document.querySelector('#funds').addEventListener('submit', (event) => {
  event.preventDefault()
  const data = new FormData(event.currentTarget)
  run({ action: event.submitter.value, token: data.get('token'), amount: data.get('amount') })
})
document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => run({ action: button.dataset.action })))
