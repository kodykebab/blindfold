// The trader flows of packages/client/cli.mjs, run by the service worker. The extension builds every transaction;
// ctx.sendTx hands it to the user's wallet (through the bridge page) to sign and returns its hash.
//
// ctx: {dep, abi: {settlement, vault, erc20}, owner, pub (viem public client), sendTx(tx, record) -> hash,
//       store: {load(), write(state)} for this account, prove({manifestSha256, request}) -> {ciphertext, ciphertextHash,
//       newBlind, oldRoot, newRoot, orderHash, preparation: {seal, journal}, online: {seal, journal}} (the helper's answers),
//       tlock: {encrypt(round, payload), check(ciphertext, round, payload)}, log(line)}
import { encodeAbiParameters, encodeFunctionData, formatUnits, keccak256, parseEventLogs, parseUnits } from 'viem'
import { balances, deadlines, exitPlan, isOpen, preflight, track } from '../../client/flow.mjs'
import { nextFunding, reconcileFunding, restoreFunding } from '../../client/admission-state.mjs'
import { encodePayload, mergeCommitments, newSalt, orderHash, replacer, reviver, schedule as batchSchedule, validateState } from './core.mjs'

const fail = (msg) => { throw new Error(msg) }
const eq = (a, b) => a?.toLowerCase() === b?.toLowerCase()

export function flows(ctx) {
  const { dep, abi, pub, owner: me, store } = ctx
  const S = dep.settlement
  const log = ctx.log ?? (() => {})
  const read = (address, functionName, args = [], which = address === dep.vault ? abi.vault : abi.settlement) =>
    pub.readContract({ address, abi: which, functionName, args })
  const has = (n) => abi.settlement.some((f) => f.type === 'function' && f.name === n)
  const now = async () => (await pub.getBlock()).timestamp
  const admissionRequired = async () => (has('admissionRequired') ? read(S, 'admissionRequired') : false)

  let tokenCache
  const tokens = () => (tokenCache ??= loadTokens())
  async function loadTokens() {
    const [t0, t1, depositToken] = await Promise.all([read(S, 'token0'), read(S, 'token1'), read(S, 'depositToken')])
    const meta = async (address) => {
      const [symbol, decimals] = await Promise.all(['symbol', 'decimals'].map((f) => read(address, f, [], abi.erc20)))
      return { address, symbol, decimals }
    }
    const [token0, token1, dt] = await Promise.all([meta(t0), meta(t1), meta(depositToken)])
    return { token0, token1, depositToken, byAddress: { [depositToken]: dt, [t0]: token0, [t1]: token1 } }
  }
  const pick = (t, name) => t[name] ?? Object.values(t.byAddress).find((x) => eq(x.address, name)) ?? fail(`unknown token ${name}; use token0 or token1`)
  const fmt = (token, v) => `${formatUnits(v, token.decimals)} ${token.symbol}`

  /**
   * Simulate first (revert reasons before any wallet prompt), then the wallet signs and sends. Only the deployment's
   * vault, settlement and tokens are ever called (S5). record ({kind, hash}) names the private state a commit or admit
   * carries: sendTx calls recordSent(record, txHash) as soon as the wallet sends it, before it is mined.
   */
  async function submit(address, which, functionName, args, record) {
    const t = await tokens()
    if (![dep.vault, S, t.token0.address, t.token1.address, t.depositToken].some((a) => eq(a, address))) fail(`refusing to call ${address}: not part of this deployment`)
    await pub.simulateContract({ account: me, address, abi: which, functionName, args })
    log(`sign ${functionName} in your wallet`)
    return ctx.sendTx({ from: me, to: address, data: encodeFunctionData({ abi: which, functionName, args }), value: '0x0', chainId: dep.chainId }, record)
  }

  /** Save a sent transaction's hash with the commitment or pending admission it carries (also for re-delivered sends). */
  async function recordSent({ kind, hash }, tx) {
    const state = await store.load()
    if (kind === 'admit' && state.admission?.pending?.hash === hash) state.admission.pending.tx = tx
    else if (kind === 'commit' && state.commitments.some((c) => c.hash === hash)) mergeCommitments(state, [{ hash, tx }])
    else return
    await store.write(state)
  }
  async function confirm(hash, what) {
    const receipt = await pub.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') fail(`${what} reverted in ${hash}`)
    return receipt
  }
  const send = async (address, which, functionName, args) => confirm(await submit(address, which, functionName, args), functionName)

  // The batch clock: deadlines from the settlement's schedule immutables, with BatchAuction's math (core.mjs, U5).
  let timing
  async function clock(b) {
    timing ??= Promise.all(['start', 'batchLength', 'revealLength', 'settleLength'].map(async (f) => BigInt(await read(S, f))))
    const [start, batchLength, revealLength, settleLength] = await timing
    return batchSchedule({ start, batchLength, revealLength, settleLength }, BigInt(b))
  }
  const schedule = async (b) => deadlines(await clock(b), await admissionRequired())
  const inSeconds = (ds, t) => ds.map((d) => ({ in: `${d.at - t}s`, at: d.at, what: d.what }))

  async function vaultView(t) {
    const open = await read(dep.vault, 'openCommitments', [me])
    const rows = await Promise.all([t.token0, t.token1].map(async (tok) => {
      const [balance, locked, wallet] = await Promise.all([
        read(dep.vault, 'balanceOf', [me, tok.address]), read(dep.vault, 'lockedOf', [me, tok.address]), read(tok.address, 'balanceOf', [me], abi.erc20)])
      return { tok, wallet, ...balances({ balance, locked, open }) }
    }))
    return { open, rows }
  }

  async function status() {
    const t = await tokens()
    const { open, rows } = await vaultView(t)
    const [b, t0] = await Promise.all([read(S, 'currentBatch'), now()])
    return {
      account: me,
      balances: rows.map((r) => ({ token: r.tok.symbol, wallet: fmt(r.tok, r.wallet), available: fmt(r.tok, r.available), reserved: fmt(r.tok, r.reserved), withdrawable: fmt(r.tok, r.withdrawable) })),
      openCommitments: open,
      note: open ? 'withdrawals blocked until each commitment is revealed and settled, slashed, released or expired' : undefined,
      batch: b, chainTime: t0, deadlines: inSeconds(await schedule(b), t0),
    }
  }

  async function deposit(name, amount) {
    const t = await tokens()
    const tok = pick(t, name)
    const value = parseUnits(amount, tok.decimals)
    if (await read(tok.address, 'allowance', [me, dep.vault], abi.erc20) < value) await send(tok.address, abi.erc20, 'approve', [dep.vault, value])
    await send(dep.vault, abi.vault, 'deposit', [tok.address, value])
    return { deposited: fmt(tok, value) }
  }

  const fundingOnchain = async () => {
    const [batch, root, step] = await read(S, 'admissionState', [me])
    return { batch, root, step }
  }
  const myCommitments = async () => track(await pub.getContractEvents({ address: S, abi: abi.settlement, fromBlock: BigInt(dep.deployBlock ?? 0) }), me)

  /** Preflight (always), then fund shortfalls, seal and commit (or prove and admit) unless dryRun. */
  async function commit({ side, amountIn, minOut, dryRun = false }) {
    if (side !== 'sell' && side !== 'buy') fail('side must be sell or buy')
    const t = await tokens()
    const [tin, tout] = side === 'sell' ? [t.token0, t.token1] : [t.token1, t.token0]
    const order = { owner: me, zeroForOne: side === 'sell', amountIn: parseUnits(amountIn, tin.decimals), minAmountOut: parseUnits(minOut, tout.decimals) }
    const [current, depositAmount, maxCommits, t0] = await Promise.all([read(S, 'currentBatch'), read(S, 'depositAmount'), read(S, 'MAX_COMMITS'), now()])
    const fee = has('commitFee') ? await read(S, 'commitFee') : 0n
    const [commitsClose, commits] = await Promise.all([read(S, 'commitsClose', [current]), read(S, 'commitIdsOf', [current])])
    const per = async (f) => Object.fromEntries(await Promise.all(Object.keys(t.byAddress).map(async (a) => [a, await f(a)])))
    const enforced = await admissionRequired()
    let funding
    if (enforced) {
      if (!dep.admission?.manifestSha256) fail('this deployment requires admission; its deployment file must include the parameter manifest')
      const state = await store.load()
      funding = reconcileFunding(dep, me, state.admission, await fundingOnchain(), t0)
      state.admission = funding
      if (!dryRun) await store.write(state)
    }
    const check = preflight({
      cumulative: enforced ? { [t.token0.address]: funding.totals[0], [t.token1.address]: funding.totals[1] } : {},
      minLead: enforced ? 60n : 3n,
      order, tokenIn: tin.address, depositToken: t.depositToken, depositAmount, fee,
      free: await per((a) => read(dep.vault, 'freeBalance', [me, a])),
      wallet: await per((a) => read(a, 'balanceOf', [me], abi.erc20)),
      allowance: await per((a) => read(a, 'allowance', [me, dep.vault], abi.erc20)),
      batch: { id: current, current, commitsClose, now: t0, commits: BigInt(commits.length), maxCommits },
      openBatches: [...new Set([...(await myCommitments()).values()].filter(isOpen).map((c) => c.batchId))],
    })
    const dt = t.byAddress[t.depositToken]
    const report = {
      ok: check.ok, problems: check.problems,
      order: `${side} ${fmt(tin, order.amountIn)} for at least ${fmt(tout, order.minAmountOut)} in batch ${current}`,
      costs: `deposit ${fmt(dt, depositAmount)} (returned minus the revealer's bounty when revealed), fee ${fmt(dt, fee)}`,
      funding: check.funding.map((f) => {
        const tok = t.byAddress[f.token]
        return `${tok.symbol}: need ${fmt(tok, f.need)}, vault free ${fmt(tok, f.free)}${f.shortfall ? `, deposit ${fmt(tok, f.shortfall)} first${f.approve ? ' (needs approval)' : ''}` : ''}`
      }),
      deadlines: inSeconds(await schedule(current), t0),
    }
    if (dryRun) return report
    if (!check.ok) fail(`preflight failed:\n  ${check.problems.join('\n  ')}`)
    for (const f of check.funding) {
      if (!f.shortfall) continue
      if (f.approve) await send(f.token, abi.erc20, 'approve', [dep.vault, f.shortfall])
      await send(dep.vault, abi.vault, 'deposit', [f.token, f.shortfall])
    }
    const salt = newSalt()
    const hash = orderHash(dep.chainId, S, current, order, salt)
    const round = await read(S, 'targetRound', [current])
    const payload = encodePayload(order, salt)
    if (enforced) {
      const budgets = await Promise.all([t.token0, t.token1].map(async (tok) => {
        const free = await read(dep.vault, 'freeBalance', [me, tok.address])
        return free - (eq(tok.address, t.depositToken) ? depositAmount + fee : 0n)
      }))
      log('generating admission proofs with the prover helper')
      const proved = await proveAdmission({ batch: current, round, funding, budgets, order, salt, hash })
      await ctx.tlock.check(proved.ciphertext, round, payload)
      const latest = await now()
      if (latest >= commitsClose) fail('proof completed after this batch closed; nothing submitted, start a new order in the current batch')
      reconcileFunding(dep, me, funding, await fundingOnchain(), latest)
      const state = await store.load()
      mergeCommitments(state, [{ id: null, batchId: current, round, hash, order, salt }])
      state.admission = { ...funding, pending: { ...proved, batch: current, closes: commitsClose } }
      await store.write(state) // before admit: a crash never loses the salt or the funding opening
      return { ...report, ...(await resumeAdmission()) }
    }
    const ciphertext = await ctx.tlock.encrypt(round, payload)
    await ctx.tlock.check(ciphertext, round, payload)
    await store.write(mergeCommitments(await store.load(), [{ id: null, batchId: current, round, hash, order, salt }])) // before sending
    const tx = await submit(S, abi.settlement, 'commit', [current, hash, ciphertext], { kind: 'commit', hash })
    const receipt = await confirm(tx, 'commit')
    const [ev] = parseEventLogs({ abi: abi.settlement, logs: receipt.logs, eventName: 'Committed' })
    await store.write(mergeCommitments(await store.load(), [{ id: ev.args.commitId, hash, tx }]))
    return { ...report, committed: ev.args.commitId, round, tx }
  }

  /** client admission.mjs proveAdmission, with the native helper in place of the child process. */
  async function proveAdmission({ batch, round, funding, budgets, order, salt, hash }) {
    if (!/^[a-f0-9]{64}$/.test(dep.admission?.manifestSha256 ?? '')) fail('deployment must pin the local admission parameter manifest')
    if (Number(dep.chainId) !== 31337) fail('single-party development parameters are restricted to local chain 31337')
    const r = await ctx.prove({
      manifestSha256: dep.admission.manifestSha256,
      request: {
        chainId: String(dep.chainId), settlement: S, owner: me, batch: String(batch), round: String(round), step: String(funding.step),
        totals: funding.totals.map(String), budgets: budgets.map(String), oldBlind: funding.blind,
        zeroForOne: order.zeroForOne, amount: String(order.amountIn), minimum: String(order.minAmountOut), salt,
      },
    })
    const next = nextFunding(dep, me, funding, batch, order, r.newBlind)
    if (!eq(r.oldRoot, funding.root) || !eq(r.newRoot, next.root) || !eq(r.orderHash, hash)) fail('prover and client disagree on the funding transition')
    if (!eq(keccak256(r.ciphertext), r.ciphertextHash)) fail('prover returned a ciphertext that does not match its proof statement')
    const proof = encodeAbiParameters(Array.from({ length: 4 }, () => ({ type: 'bytes' })), [r.preparation.seal, r.preparation.journal, r.online.seal, r.online.journal])
    return { hash, ciphertext: r.ciphertext, proof, next }
  }

  /** Send (or confirm) the saved pending admission and reconcile private state with admissionState(owner). */
  async function resumeAdmission() {
    if (!dep.admission?.manifestSha256 || !await admissionRequired()) fail('this deployment does not use proof-enforced admission')
    const state = await store.load()
    const pending = state.admission?.pending
    if (!pending) {
      state.admission = reconcileFunding(dep, me, state.admission, await fundingOnchain(), await now())
      await store.write(state)
      return { resumed: 'private funding state matches the chain' }
    }
    try {
      state.admission = reconcileFunding(dep, me, state.admission, await fundingOnchain(), await now())
      await store.write(state)
      return { resumed: 'pending admission reconciled with chain state' }
    } catch (e) { if (!e.message.includes('run resume-admission')) throw e }
    const tx = pending.tx ?? await submit(S, abi.settlement, 'admit', [pending.batch, pending.hash, pending.ciphertext, pending.proof], { kind: 'admit', hash: pending.hash })
    const receipt = await pub.waitForTransactionReceipt({ hash: tx })
    if (receipt.status !== 'success') fail(`admission reverted in ${tx}; pending state retained until its batch closes`)
    const [ev] = parseEventLogs({ abi: abi.settlement, logs: receipt.logs, eventName: 'Committed' })
    if (!ev || ev.args.hash !== pending.hash) fail('admission receipt did not contain the expected commitment; pending state retained')
    const after = await store.load() // recordSent saved the hash meanwhile
    mergeCommitments(after, [{ id: ev.args.commitId, hash: pending.hash, tx }])
    after.admission = reconcileFunding(dep, me, after.admission, await fundingOnchain(), await now())
    await store.write(after)
    return { admitted: ev.args.commitId, tx }
  }

  async function trackAll() {
    const t = await tokens()
    return [...(await myCommitments()).values()].map((c) => {
      const o = c.order
      return {
        id: c.id, batchId: c.batchId, state: c.state, order: o ? `${o.zeroForOne ? 'sell' : 'buy'} ${o.amountIn}` : 'sealed',
        got: c.state === 'filled' ? fmt(o.zeroForOne ? t.token1 : t.token0, c.amountOut) : undefined,
      }
    })
  }

  /** Open commitments and the step that clears each; saved: Set of hashes this device can reveal (null if locked). */
  async function exitSteps(saved) {
    const open = [...(await myCommitments()).values()].filter(isOpen)
    const t0 = await now()
    const sched = new Map()
    for (const b of new Set(open.map((c) => c.batchId))) sched.set(b, await clock(b))
    return { now: t0, steps: exitPlan(open, { now: t0, sched, saved, admissionRequired: await admissionRequired() }) }
  }
  const describe = ({ c, action, at, why }, t0) => ({ id: c.id, batchId: c.batchId, state: c.state, action, wait: action === 'wait' ? `${at - t0}s` : undefined, at, why })

  async function kept() {
    return new Map((await store.load()).commitments.map((x) => [x.hash, x]))
  }
  async function blockers() {
    const { now: t0, steps } = await exitSteps(new Set((await kept()).keys()))
    return steps.map((s) => describe(s, t0))
  }

  /** Guided exit: one transaction per step, in order (reveal own saved orders, slash or release, expire). */
  async function cleanup({ dryRun = false } = {}) {
    const saved = await kept()
    const { now: t0, steps } = await exitSteps(new Set(saved.keys()))
    const expired = new Set()
    const done = []
    for (const s of steps) {
      done.push(describe(s, t0))
      if (dryRun || s.action === 'wait') continue
      const { id, batchId } = s.c
      if (s.action === 'reveal') await send(S, abi.settlement, 'reveal', [id, saved.get(s.c.hash).order, saved.get(s.c.hash).salt])
      if (s.action === 'slash' || s.action === 'release') await send(S, abi.settlement, 'slashUnrevealed', [id])
      if (s.action === 'expire' && !expired.has(batchId)) {
        expired.add(batchId)
        await send(S, abi.settlement, 'expire', [batchId])
      }
    }
    return { steps: done, stillOpen: dryRun ? undefined : await read(dep.vault, 'openCommitments', [me]) }
  }

  async function withdraw(name, amount = 'all') {
    const t = await tokens()
    const tok = pick(t, name)
    const { open, rows } = await vaultView(t)
    if (open) {
      const { now: t0, steps } = await exitSteps(new Set((await kept()).keys()))
      fail(`${open} open commitment(s) block withdrawals of every token:\n  ${steps.map((s) => JSON.stringify(describe(s, t0), replacer)).join('\n  ')}\nrun cleanup`)
    }
    const row = rows.find((r) => r.tok === tok)
    const value = amount === 'all' ? row.withdrawable : parseUnits(amount, tok.decimals)
    if (value > row.withdrawable) fail(`only ${fmt(tok, row.withdrawable)} is withdrawable`)
    await send(dep.vault, abi.vault, 'withdraw', [tok.address, value])
    return { withdrew: fmt(tok, value) }
  }

  const exportState = async () => JSON.stringify(await store.load(), replacer, 2)

  /** Restore an export (CLI or extension): refused unless every entry hashes right and matches the chain. */
  async function importState(text) {
    const imported = JSON.parse(text, reviver)
    const chainHashes = new Map()
    for (const c of imported.commitments ?? []) if (c.id != null) chainHashes.set(c.id, (await read(S, 'commitments', [c.id]))[3])
    const problems = validateState(imported, { dep, owner: me, chainHashes })
    if (problems.length) fail(`refusing to import:\n  ${problems.join('\n  ')}`)
    const state = await store.load()
    if (await admissionRequired()) {
      imported.admission = restoreFunding(dep, me, imported.admission, await fundingOnchain(), await now())
      if (state.admission?.pending) fail('resolve the local pending admission before importing another state')
    }
    mergeCommitments(state, imported.commitments ?? [])
    if (imported.admission) state.admission = imported.admission
    await store.write(state)
    return { imported: imported.commitments?.length ?? 0, saved: state.commitments.length }
  }

  return { status, deposit, commit, resumeAdmission, recordSent, track: trackAll, blockers, cleanup, withdraw, exportState, importState, exitSteps, clock }
}
