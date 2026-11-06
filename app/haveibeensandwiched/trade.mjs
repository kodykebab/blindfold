import {
  amountLimits, balanceFields, batchPhase, displayPair, explainClientError, fundFirst, liquidityNote, mempoolView, quoteLine,
  parseBlockers, parsePreflight, parseStatus, parseTrack, presentJob, preparedBatch, reviewChanges,
  stampQuote, transferCheck, validateAmount,
} from './status.mjs'
import {
  parseTrack as parseTrackJson,
  parseBlockers as parseBlockersJson,
  parseCleanup as parseCleanupJson,
  orderRows,
  withdrawalSummary,
  policyText,
  formatCountdown,
} from './orders.mjs'
import { createBackupReminder, createJobStore } from './job-store.mjs'
import { backupReminder, identityChanged, importProblems, preparationPanel, proverSteps, reminderNeedsExport } from './prover-view.mjs'
import { createWalletView, walletMismatch } from './wallet-view.mjs'
const output = document.querySelector('#output')
const state = document.querySelector('#job-state')
const reconnect = document.querySelector('#reconnect')
const reminder = document.querySelector('#backup-reminder')
const reminderStore = (() => { try { return createBackupReminder(localStorage) } catch { return createBackupReminder(null) } })()
// The reminder clears only once a backup exported after the last submission is confirmed saved (prover-view.mjs).
const REMINDER_KEY = 'blindfold.backupReminderState'
let reminderState = (() => { try { return JSON.parse(localStorage.getItem(REMINDER_KEY)) } catch { return null } })()
  ?? (reminderStore.get() ? backupReminder(null, 'submitted', 0) : null)
function backupEvent(event) {
  reminderState = backupReminder(reminderState, event)
  try { localStorage.setItem(REMINDER_KEY, JSON.stringify(reminderState)) } catch {}
  reminderStore.set(reminderState.pending)
  reminder.hidden = !reminderState.pending
  document.querySelector('#backup-reminder-note').textContent = reminderState.pending && !reminderNeedsExport(reminderState) ? 'Backup exported.' : ''
}
reminder.hidden = !reminderState?.pending
const stepsEl = document.querySelector('#prover-steps')
function renderSteps(job) {
  let typical = null
  try { typical = Number(localStorage.getItem('blindfold.proveSeconds')) || null } catch {}
  const view = proverSteps(job, { typicalSeconds: typical })
  stepsEl.hidden = !view
  if (!view) return
  stepsEl.replaceChildren(...view.steps.map((step) => {
    const item = document.createElement('li')
    item.className = `step ${step.status}`
    item.textContent = `${step.name}: ${step.status}${step.detail ? ` (${step.detail})` : ''}`
    if (step.status === 'current') item.setAttribute('aria-current', 'step')
    return item
  }))
  if (job.state === 'done' && view.seconds) try { localStorage.setItem('blindfold.proveSeconds', String(view.seconds)) } catch {}
}
let lastIdentity = null
// Server and network errors as a sentence and a next step, never the raw message.
function showError(message) { const why = explainClientError(message); output.textContent = `${why.sentence} ${why.next}`; state.textContent = 'FAILED' }
const jobStore = (() => { try { return createJobStore(localStorage) } catch { return createJobStore(null) } })()
const mobile = matchMedia('(max-width: 760px) and (pointer: coarse)')
const desktopOnly = new Set(['prepare-admission', 'preflight', 'commit', 'deposit', 'cleanup', 'resume-admission', 'backup-import'])
let busy = false, lastStatus = null, walletState = { wallets: [], selected: null }
let lastReview = null, confirmAfterReview = false, depositWatch = null, transferBlock = null, queued = null
let latestTrack = null, latestBlockers = null, countdownTimer = null
const savedJob = () => jobStore.get()
const saveJob = (id) => jobStore.set(id)
function setBusy(value) {
  busy = value
  document.querySelector('#job-progress').hidden = !value
  const mismatch = walletMismatch(walletState.selected, lastStatus)
  document.querySelectorAll('button, input, select').forEach((control) => { control.disabled = value || (mobile.matches && Boolean(control.closest('[data-desktop-only]'))) || (Boolean(mismatch) && Boolean(control.closest('[data-wallet-guard]'))) })
  document.querySelector('#wallet-choice').disabled = value || !walletState.wallets.length
  document.querySelector('#wallet-connect').disabled = value || !walletState.wallets.length
  if (!value) document.querySelector('#confirm').disabled = !canConfirm()

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
      const view = presentJob(job)
      output.textContent = view.body
      renderSteps(job)
      if (job.state === 'running') state.textContent = view.title
      if (job.state !== 'running') {
        if (job.action === 'preflight') showReview(job.output, job.state === 'done')
        if (job.state === 'done' && job.action === 'status') {
          showStatus(job.output)
          queued = { action: 'track' }
        }
        if (job.state === 'done' && job.action === 'track') {
          showOrders(job.output)
          queued = { action: 'blockers' }
        }
        if (job.state === 'done' && job.action === 'blockers') {
          showBlockers(job.output)
        }
        if (job.state === 'done' && job.action === 'cleanup-preview') showBlockers(job.output)
        if (job.state === 'done' && job.action === 'prepare-admission') {
          const prepared = preparedBatch(job.output)
          if (prepared !== null) document.querySelector('#preparation-state').textContent = `Prepared for batch ${prepared}. Refresh status before submitting.`
        }
        if (job.state === 'done' && job.action === 'backup-export' && typeof job.backup === 'string') {
          const url = URL.createObjectURL(new Blob([job.backup], { type: 'application/json' }))
          const link = document.createElement('a'); link.href = url; link.download = 'blindfold-backup.json'; link.click()
          setTimeout(() => URL.revokeObjectURL(url), 10000)
          output.textContent = 'A backup download was requested. Save it somewhere private, then mark it saved.'
        }
        if (job.state === 'done' && job.action === 'deposit') noteDeposit(job.output)
        if (job.state === 'done' && job.action === 'backup-export') backupEvent('exported')
        document.querySelector('#resume-admission').hidden = !(job.state === 'failed' && explainClientError(job.output).title === 'Admission needs a resume')
        if (job.state === 'failed' && job.action === 'backup-import') {
          const problems = importProblems(job.output)
          if (problems.length) output.textContent = `Backup not restored. ${problems.map((p) => p.text).join(' ')} Nothing in your local state changed.`
        }
        if (job.state === 'done' && ['commit', 'cleanup', 'withdraw', 'deposit', 'resume-admission'].includes(job.action)) {
          queued = { action: 'status' }
        }
        saveJob(null); state.textContent = job.state === 'done' ? 'COMPLETE' : 'FAILED'; break
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  } catch (e) {
    output.textContent = `${explainClientError(e.message).sentence} The command may still be running on this machine; use Reconnect.`
    state.textContent = 'DISCONNECTED'; reconnect.hidden = !savedJob()
  } finally {
    setBusy(false)
    const next = queued
    queued = null
    if (next) await run(next)
  }
}
async function run(input) {
  if (busy) return
  if (savedJob()) { await follow(savedJob()); return }
  const guarded = new Set(['prepare-admission', 'preflight', 'commit', 'deposit', 'withdraw', 'cleanup', 'resume-admission', 'backup-export', 'backup-import'])
  const mismatch = walletMismatch(walletState.selected, lastStatus)
  if (mismatch && guarded.has(input.action)) { output.textContent = mismatch; state.textContent = 'ACCOUNT CHECK'; return }
  if (mobile.matches && desktopOnly.has(input.action)) { output.textContent = 'Use a desktop to run this action.'; state.textContent = 'DESKTOP ONLY'; return }
  setBusy(true); state.textContent = 'STARTING'; output.textContent = 'Starting the local client on this machine.'
  try {
    const response = await fetch('/api/trade', { method: 'POST', headers: { 'content-type': 'application/json', 'x-blindfold-request': '1' }, body: JSON.stringify(input) })
    const data = await response.json()
    if (!response.ok) throw Error(data.error || 'Could not start command')
    saveJob(data.id)
    if (input.action === 'commit') {
      backupEvent('submitted')
      document.querySelector('#preparation-state').textContent = 'Submission may consume the prepared key. Refresh status before the next order.'
    }
    await follow(data.id)
  } catch (e) { showError(e.message) }
  finally { setBusy(false) }
}
async function cleanupWithPreview(row) {
  if (busy) return
  setBusy(true)
  state.textContent = 'PREVIEW'
  output.textContent = 'Previewing cleanup...'
  try {
    const res = await fetch('/api/trade', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-blindfold-request': '1' },
      body: JSON.stringify({ action: 'cleanup-preview' }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Could not start cleanup preview')
    let job
    do {
      await new Promise((r) => setTimeout(r, 200))
      const jr = await fetch(`/api/trade/${encodeURIComponent(data.id)}`)
      job = await jr.json()
    } while (job.state === 'running')
    if (job.state !== 'done') throw new Error(job.error || 'Cleanup preview failed')
    const parsed = parseCleanupJson(job.output)
    const list = (parsed.done ?? []).map((d) => `${d.action} order #${d.id}`).join('\n')
    setBusy(false)
    const ok = window.confirm(`The following action(s) will be sent:\n${list || 'None'}\n\nProceed?`)
    if (ok) {
      run({ action: 'cleanup' })
    }
  } catch (e) {
    setBusy(false)
    showError(e.message)
  }
}

function renderOrders() {
  const policyEl = document.querySelector('#orders-policy')
  if (policyEl && latestTrack?.policy) {
    policyEl.textContent = policyText(latestTrack.policy)
  }

  const summaryEl = document.querySelector('#withdrawal-summary')
  const summaryText = withdrawalSummary(latestTrack, latestBlockers)
  if (summaryEl) summaryEl.textContent = summaryText

  const withdrawContainer = document.querySelector('#withdraw-all-container')
  if (withdrawContainer) {
    withdrawContainer.replaceChildren()
    if (summaryText === 'Nothing blocks withdrawal') {
      const tokens = ['token0', 'token1']
      for (const tok of tokens) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'secondary'
        btn.dataset.walletGuard = ''
        btn.textContent = `Withdraw all ${tok}`
        btn.setAttribute('aria-label', `Withdraw all ${tok}`)
        btn.disabled = busy
        btn.addEventListener('click', () => {
          run({ action: 'withdraw', token: tok, amount: 'all' })
        })
        withdrawContainer.append(btn)
      }
    }
  }

  const tbody = document.querySelector('#orders-table-body')
  if (!tbody) return
  tbody.replaceChildren()

  if (countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }

  const rows = orderRows(latestTrack, latestBlockers)
  if (!rows.length) {
    const tr = document.createElement('tr')
    const td = document.createElement('td')
    td.colSpan = 5
    td.style.padding = '14px 4px'
    td.style.color = 'var(--mute, #888)'
    td.textContent = 'No commitments found for this account.'
    tr.append(td)
    tbody.append(tr)
    return
  }

  const waitSpans = []

  for (const row of rows) {
    const tr = document.createElement('tr')
    tr.style.borderBottom = '1px solid var(--edge, #2a2e3d)'

    // Order
    const tdOrder = document.createElement('td')
    tdOrder.style.padding = '10px 4px'
    const title = document.createElement('strong')
    title.textContent = row.title
    const outcome = document.createElement('p')
    outcome.className = 'fine muted'
    outcome.style.margin = '4px 0 0'
    outcome.textContent = row.outcome
    tdOrder.append(title, outcome)

    // Batch
    const tdBatch = document.createElement('td')
    tdBatch.style.padding = '10px 4px'
    tdBatch.textContent = row.batch

    // Stage
    const tdStage = document.createElement('td')
    tdStage.style.padding = '10px 4px'
    const stageSpan = document.createElement('span')
    stageSpan.className = 'order-state'
    stageSpan.textContent = row.stage
    tdStage.append(stageSpan)

    // Amounts
    const tdAmounts = document.createElement('td')
    tdAmounts.style.padding = '10px 4px'
    const ex = row.amounts.executedIn ?? '—'
    const rec = row.amounts.received ?? '—'
    const un = row.amounts.unusedIn ?? '—'
    tdAmounts.textContent = `${ex} / ${rec} / ${un}`

    // Next step
    const tdNext = document.createElement('td')
    tdNext.style.padding = '10px 4px'
    if (row.next?.button) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'secondary'
      btn.dataset.walletGuard = ''
      btn.disabled = busy
      btn.textContent = row.next.button
      const isReveal = row.next.action === 'reveal'
      btn.setAttribute('aria-label', `${isReveal ? 'Reveal' : 'Clean up'} order #${row.id}`)
      btn.addEventListener('click', () => cleanupWithPreview(row))
      tdNext.append(btn)
    } else if (row.next?.action === 'wait' && row.next.at != null) {
      const span = document.createElement('span')
      span.textContent = row.next.text
      span.dataset.at = String(row.next.at)
      tdNext.append(span)
      waitSpans.push(span)
    } else if (row.next?.text) {
      tdNext.textContent = row.next.text
    } else {
      tdNext.textContent = '—'
    }

    tr.append(tdOrder, tdBatch, tdStage, tdAmounts, tdNext)
    tbody.append(tr)
  }

  if (waitSpans.length > 0) {
    countdownTimer = setInterval(() => {
      const currentNow = Math.floor(Date.now() / 1000)
      let needsRefresh = false
      for (const span of waitSpans) {
        const at = Number(span.dataset.at)
        const diff = at - currentNow
        if (diff <= 0) {
          needsRefresh = true
          span.textContent = 'Wait 00:00'
        } else {
          span.textContent = `Wait ${formatCountdown(diff)}`
        }
      }
      if (needsRefresh) {
        clearInterval(countdownTimer)
        countdownTimer = null
        run({ action: 'track' })
      }
    }, 1000)
  }
}

function showBlockers(text) {
  const json = parseBlockersJson(text)
  if (!json.error) {
    latestBlockers = json
    renderOrders()
    return
  }
  const rows = parseBlockers(text)
  if (rows === null) return
  const list = document.querySelector('#blocker-list'); if (list) list.replaceChildren()
  const msg = document.querySelector('#blockers-message'); if (msg) msg.textContent = rows.length ? 'These commitments are holding withdrawals.' : 'No commitments currently block withdrawal.'
  for (const row of rows) {
    const item = document.createElement('li')
    const title = document.createElement('strong'); title.textContent = `Order #${row.id} · batch ${row.batch}`
    const action = document.createElement('span'); action.className = 'order-state'; action.textContent = row.action
    const reason = document.createElement('p'); reason.textContent = row.reason
    item.append(title, action, reason); if (list) list.append(item)
  }
}

function showOrders(text) {
  const json = parseTrackJson(text)
  if (!json.error) {
    latestTrack = json
    renderOrders()
    const mempool = mempoolView(json.orders)
    const memEl = document.querySelector('#mempool-count')
    if (memEl) memEl.textContent = `${mempool.committed} committed and not yet revealed. ${mempool.note}`
    return
  }
  const rows = parseTrack(text)
  if (rows === null) return
  const list = document.querySelector('#order-list'); if (list) list.replaceChildren()
  const msg = document.querySelector('#orders-message'); if (msg) msg.textContent = rows.length ? 'Latest status from the settlement contract. Fills can be partial, and unused input stays in the vault.' : 'No commitments found for this account.'
  const mempool = mempoolView(rows)
  const memEl = document.querySelector('#mempool-count')
  if (memEl) memEl.textContent = `${mempool.committed} committed and not yet revealed. ${mempool.note}`
  for (const row of rows) {
    const item = document.createElement('li')
    const title = document.createElement('strong'); title.textContent = `Order #${row.id} · batch ${row.batch}`
    const state = document.createElement('span'); state.className = 'order-state'; state.textContent = row.state
    const detail = document.createElement('p'); detail.textContent = row.summary || row.detail
    item.append(title, state, detail); if (list) list.append(item)
  }
}
function showStatus(text) {
  const parsed = parseStatus(text)
  if (!parsed) return
  lastStatus = parsed
  renderWallet(walletState)
  document.querySelector('#account-address').textContent = parsed.account
  const pair = displayPair(parsed)
  document.querySelector('#network-pair').textContent = [parsed.network, pair.label].filter(Boolean).join(' · ')
  const [token0, token1] = pair.symbols
  if (token0 && token1) {
    labelSide('#side-sell', `Sell ${token0}`, `FOR ${token1}`)
    labelSide('#side-buy', `Buy ${token0}`, `WITH ${token1}`)
  }
  document.querySelector('#batch-status').textContent = parsed.batch
  const current = parsed.batch.match(/^batch (\d+) /)
  const prep = preparationPanel(parsed.preparation ?? '', current?.[1] ?? null)
  const identity = { account: parsed.account, network: parsed.network, pair: parsed.pair }
  const changed = identityChanged(lastIdentity, identity)
  lastIdentity = identity
  // A changed account, network or pair invalidates the last review: submit stays off until a fresh review.
  if (changed) { lastReview = null; document.querySelector('#confirm').disabled = true }
  document.querySelector('#preparation-state').textContent = changed ? `Re-check needed: the account, network or pair changed since the last status. ${prep.text}` : prep.text
  const prepareNext = document.querySelector('#prepare-next')
  prepareNext.hidden = !prep.action
  if (prep.action) { prepareNext.textContent = prep.action.label; prepareNext.dataset.batch = prep.action.batch }
  const batchInput = document.querySelector('#prepare input[name=batch]')
  if (!batchInput.value && current && BigInt(current[1]) + 1n < (1n << 64n)) batchInput.value = String(BigInt(current[1]) + 1n)
  document.querySelector('#open-status').textContent = parsed.open
  const phase = batchPhase(parsed.deadlines)
  document.querySelector('#batch-phase').textContent = phase.phase === 'unknown'
    ? parsed.batch
    : `${parsed.batch}. Phase: ${phase.phase}. ${phase.deadlines.map((row) => `${row.seconds}s ${row.what}`).join(' · ')}`
  const rows = document.querySelector('#balance-rows'); rows.replaceChildren()
  for (const row of parsed.rows) {
    const section = document.createElement('div'); section.className = 'balance-row'
    const token = document.createElement('strong'); token.textContent = row.token; section.append(token)
    for (const field of balanceFields(row)) {
      const item = document.createElement('span'); item.textContent = `${field.label}: ${field.value}`; section.append(item)
    }
    rows.append(section)
  }
  document.querySelector('#deadlines').textContent = parsed.deadlines.join(' · ')
  const side = document.querySelector('#order input[name=side]:checked')?.value || 'sell'
  const inputDecimals = decimalsFor(parsed, side === 'sell' ? 'token0' : 'token1')
  const outputDecimals = decimalsFor(parsed, side === 'sell' ? 'token1' : 'token0')
  document.querySelector('#amount-limits').textContent = `${amountLimits(inputDecimals)} Minimum out: ${amountLimits(outputDecimals)}`
  if (depositWatch && parsed.rows.length) {
    const row = parsed.rows.find((item) => item.token === depositWatch.token || item.token.startsWith(depositWatch.token))
    const check = row ? transferCheck({ before: depositWatch.before, after: row.available, sent: depositWatch.sent }) : { checked: false }
    if (check.checked && !check.ok) {
      transferBlock = check.message
      output.textContent = check.message
      state.textContent = 'UNSUPPORTED TOKEN'
    }
    depositWatch = null
  }
  document.querySelector('#balances').hidden = false
  const quoteEl = document.querySelector('#quote-line')
  if (quoteEl) {
    const stamped = stampQuote(parsed.quote)
    quoteEl.textContent = quoteLine(stamped, parsed.quoteRaw)
    quoteEl.classList.toggle('stale', Boolean(stamped?.stale))
  }
  const liquidityEl = document.querySelector('#liquidity-line')
  if (liquidityEl) liquidityEl.textContent = liquidityNote(parsed.liquidity)
}
function labelSide(selector, title, small) {
  const node = document.querySelector(selector)
  node.replaceChildren(document.createTextNode(`${title} `))
  const note = document.createElement('small'); note.textContent = small; node.append(note)
}
function decimalsFor(parsed, role) {
  return parsed?.tokens?.find((token) => token.role === role)?.decimals ?? null
}
function orderFields() {
  const data = new FormData(document.querySelector('#order'))
  return { side: data.get('side'), amount: String(data.get('amount') ?? ''), minimum: String(data.get('minimum') ?? '') }
}
function selectedDecimals() {
  const { side } = orderFields()
  return {
    input: decimalsFor(lastStatus, side === 'sell' ? 'token0' : 'token1'),
    output: decimalsFor(lastStatus, side === 'sell' ? 'token1' : 'token0'),
  }
}
function applyAmountValidity() {
  const { amount, minimum } = orderFields()
  const { input, output } = selectedDecimals()
  const amountBox = document.querySelector('#amount-in')
  const minimumBox = document.querySelector('#minimum-out')
  const amountCheck = validateAmount(amount, { decimals: input })
  const minimumCheck = validateAmount(minimum, { decimals: output })
  amountBox.setCustomValidity(amountCheck.ok ? '' : amountCheck.message)
  minimumBox.setCustomValidity(minimumCheck.ok ? '' : minimumCheck.message)
  document.querySelector('#amount-limits').textContent = `Amount in: ${amountLimits(input)} Minimum out: ${amountLimits(output)}`
  return amountCheck.ok && minimumCheck.ok
}
function showReview(text, finished) {
  const review = parsePreflight(text)
  const panel = document.querySelector('#review')
  const confirm = document.querySelector('#confirm')
  const quote = document.querySelector('#quote-line')
  const liquidity = document.querySelector('#liquidity-line')
  if (!review) {
    panel.hidden = false
    panel.textContent = finished ? 'The preview did not include an order this page can show. Review it again.' : explainClientError(text).sentence
    confirm.disabled = true
    lastReview = null
    return
  }
  const stamped = { ...review, quote: stampQuote(review.quote) }
  const block = [transferBlock, fundFirst(stamped), stamped.oneBatch].filter(Boolean).join(' ')
  if (confirmAfterReview && lastReview) {
    const changes = reviewChanges(lastReview, stamped)
    if (changes.length) {
      panel.hidden = false
      panel.classList.add('blocked')
      panel.textContent = `The order changed since the last review.\n${changes.join('\n')}\nReview it again, then confirm.`
      quote.textContent = quoteLine(stamped.quote, stamped.quoteRaw)
      quote.classList.toggle('stale', Boolean(stamped.quote?.stale))
      liquidity.textContent = liquidityNote(stamped.liquidity)
      document.querySelector('#batch-rule').textContent = stamped.oneBatch || 'One batch at a time per account. A new order waits until the current one settles or is released.'
      confirm.disabled = true
      confirmAfterReview = false
      lastReview = stamped
      return
    }
  }
  lastReview = stamped
  panel.hidden = false
  panel.classList.toggle('blocked', !stamped.ok || Boolean(block) || Boolean(stamped.quote?.stale))
  panel.textContent = presentJob({ state: 'done', action: 'preflight', output: text }).body
  quote.textContent = `${quoteLine(stamped.quote, stamped.quoteRaw)} Shown next to your minimum of ${stamped.minimum}.`
  quote.classList.toggle('stale', Boolean(stamped.quote?.stale))
  liquidity.textContent = liquidityNote(stamped.liquidity)
  document.querySelector('#batch-rule').textContent = stamped.oneBatch || 'One batch at a time per account. A new order waits until the current one settles or is released.'
  const allow = stamped.ok && !block && !stamped.quote?.stale
  confirm.disabled = !allow
  // Inputs are disabled while a job runs and FormData skips disabled fields: commit what was confirmed.
  if (confirmAfterReview && allow) queued = { action: 'commit', ...confirmFields }
  confirmAfterReview = false
}
function canConfirm() {
  if (transferBlock || !lastReview?.ok || lastReview.oneBatch || fundFirst(lastReview) || lastReview.quote?.stale) return false
  return true
}
function noteDeposit(text) {
  const sent = text.match(/deposited (\d+(?:\.\d+)?)/)?.[1]
  const symbol = text.match(/deposited \d+(?:\.\d+)? (\S+)/)?.[1]
  const row = lastStatus?.rows?.find((item) => item.token === symbol)
  if (sent && row) {
    depositWatch = { token: symbol, before: row.available, sent }
    queued = { action: 'status' }
  }
}
document.querySelector('#backup-confirm').addEventListener('click', () => {
  if (reminderNeedsExport(reminderState)) { document.querySelector('#backup-reminder-note').textContent = 'Export a backup first: this stays until a backup made after your last order is saved.'; return }
  backupEvent('acknowledged')
})
document.querySelector('#prepare-next').addEventListener('click', (event) => run({ action: 'prepare-admission', batch: event.currentTarget.dataset.batch }))
document.querySelector('#resume-admission').addEventListener('click', () => run({ action: 'resume-admission' }))
const order = document.querySelector('#order')
let confirmFields = null
function orderAction(action) {
  if (!applyAmountValidity() || !order.reportValidity()) return
  if (transferBlock) { output.textContent = transferBlock; state.textContent = 'UNSUPPORTED TOKEN'; return }
  const fields = orderFields()
  if (action === 'commit') {
    if (!lastReview) { output.textContent = 'Review the order before confirming it.'; state.textContent = 'REVIEW'; return }
    confirmAfterReview = true
    confirmFields = fields
    run({ action: 'preflight', ...fields })
    return
  }
  confirmAfterReview = false
  lastReview = null
  run({ action, ...fields })
}
document.querySelector('#amount-in').addEventListener('input', applyAmountValidity)
document.querySelector('#minimum-out').addEventListener('input', applyAmountValidity)
document.querySelectorAll('#order input[name=side]').forEach((input) => input.addEventListener('change', () => { lastReview = null; document.querySelector('#confirm').disabled = true; applyAmountValidity() }))
document.querySelector('#preview').addEventListener('click', () => orderAction('preflight'))
document.querySelector('#confirm').addEventListener('click', () => orderAction('commit'))
order.addEventListener('submit', (event) => { event.preventDefault(); orderAction('preflight') })
document.querySelector('#prepare').addEventListener('submit', (event) => { event.preventDefault(); run({ action: 'prepare-admission', batch: new FormData(event.currentTarget).get('batch') }) })
document.querySelector('#funds').addEventListener('submit', (event) => {
  event.preventDefault()
  const data = new FormData(event.currentTarget)
  const token = data.get('token')
  const amount = String(data.get('amount') ?? '')
  if (!['token0', 'token1'].includes(token)) { output.textContent = 'That token is not supported in this deployment.'; state.textContent = 'UNSUPPORTED TOKEN'; return }
  const withdrawingAll = event.submitter.value === 'withdraw' && amount === 'all'
  const check = validateAmount(amount, { decimals: decimalsFor(lastStatus, token), allowAll: withdrawingAll })
  if (!check.ok) { output.textContent = check.message; state.textContent = 'AMOUNT'; return }
  run({ action: event.submitter.value, token, amount })
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
  catch (e) { document.querySelector('#wallet-message').textContent = e?.code === 4001 ? 'You declined the wallet connection. Nothing was shared.' : 'Could not view the wallet. Unlock it in the extension and try again.' }
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
  } catch (e) { showError(e.message) }
  finally { event.currentTarget.value = '' }
})

async function loadHistory() {
  const message = document.querySelector('#history-message')
  const list = document.querySelector('#history-list')
  try {
    const response = await fetch('/api/history', { cache: 'no-store' })
    const body = await response.json()
    if (!response.ok || body.unavailable) {
      message.textContent = 'History unavailable. Trading, tracking and withdrawal still use the chain.'
      list.replaceChildren()
      return
    }
    message.textContent = body.batches.length ? 'Settled batches mirrored from public chain data.' : 'No settled batches are stored yet.'
    list.replaceChildren()
    for (const batch of body.batches) {
      const item = document.createElement('li')
      item.textContent = `Batch ${batch.batchId}: clearing price ${batch.clearingPrice}, ${batch.orderCount} orders, settle ${batch.settleTx}`
      list.append(item)
    }
  } catch {
    message.textContent = 'History unavailable. Trading, tracking and withdrawal still use the chain.'
  }
}
async function loadCourt() {
  const section = document.querySelector('#court-view')
  try {
    const response = await fetch('/api/court', { cache: 'no-store' })
    const body = await response.json()
    if (body.hidden) { section.hidden = true; return }
    section.hidden = false
    const message = document.querySelector('#court-message')
    const list = document.querySelector('#court-list')
    if (body.unavailable) { message.textContent = 'Court ledger unavailable.'; list.replaceChildren(); return }
    message.textContent = 'Bonds, claims and payouts from BondRegistry events.'
    list.replaceChildren()
    for (const row of body.rows ?? []) {
      const item = document.createElement('li')
      item.textContent = row
      list.append(item)
    }
  } catch { document.querySelector('#court-view').hidden = true }
}
document.querySelector('#history-refresh').addEventListener('click', loadHistory)
loadHistory()
loadCourt()
