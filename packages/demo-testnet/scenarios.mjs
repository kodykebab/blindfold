// STORIES.md acceptance scenarios on the testnet deployment (admission off). Each scenario drives the client CLI as one
// demo wallet, runs the keeper (account 1) and the solver (account 2) once each when their work is due, and prints the
// evidence each story asks for. Stop any keeper or solver service first: the outage scenario needs them absent.
//   npm run scenario -- first-trade   T01-T05, T10, T11, T14  victim1: review, fund, commit, keeper reveal, settle, withdraw
//   npm run scenario -- repeat        T08, T14                victim2: two orders in one batch, then a third from the proceeds
//   npm run scenario -- restore       T15                     victim3: a wiped device restores its encrypted backup and reveals
//   npm run scenario -- no-fill       T03, T11-T14            victim4: a limit nobody meets stays unfilled; resubmit; withdraw
//   npm run scenario -- outage        T10, T12, O01, O03      victim5: solver down (keeper settles), then both down (expiry)
//   npm run scenario -- griefers      O01, O02                a garbage commitment is slashed; a bad solver price reverts
//   npm run scenario -- all           every scenario above, in order (about 20 minutes with 60 s batches)
import { rmSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { keccak256, toHex } from 'viem'
import { ROLES, account, artifact, chain, explorerTx, here, pub, victimIndex, wallet } from './common.mjs'
import { SETTLEMENT, chainNow, cli, deployment, keeperOnce, openBatch, read, revealBatch, settleBatch, waitUntil } from './flow.mjs'
import { parseTrack } from './lib.mjs'

const ERC20 = artifact('MockERC20.sol', 'MockERC20')
const VAULT = artifact('BlindfoldVault.sol', 'BlindfoldVault')
const victim = (k) => ({ index: victimIndex(k - 1), name: `victim${k}` })
const say = (stories, text) => console.log(`\n\x1b[1m[${stories}]\x1b[0m ${text}`)
/** Print a CLI result indented; a failure stops the scenario unless it is the expected outcome. */
function show(r, { expectFail = false } = {}) {
  for (const line of [r.out, r.err].join('\n').split('\n')) if (line.trim()) console.log(`    ${line}`)
  if (r.code && !expectFail) throw new Error('that step failed')
  if (!r.code && expectFail) throw new Error('that step should have been refused')
}
const trackBatch = async (w, b) => parseTrack((await cli(w.index, ['track'])).out).filter((c) => BigInt(c.batch) === b)
const balanceOf = (token, owner) => pub.readContract({ address: token, abi: ERC20.abi, functionName: 'balanceOf', args: [owner] })
const walletTokens = (owner) => Promise.all(['token0', 'token1'].map((t) => balanceOf(deployment()[t], owner)))
async function withdrawAll(w) {
  show(await cli(w.index, ['blockers']))
  const owner = account(w.index).address
  for (const t of ['token0', 'token1']) {
    const held = await pub.readContract({ address: deployment().vault, abi: VAULT.abi, functionName: 'balanceOf', args: [owner, deployment()[t]] })
    if (held > 0n) show(await cli(w.index, ['withdraw', t, 'all']))
  }
}
const expect = (ok, what) => { if (!ok) throw new Error(`expected ${what}`) ; console.log(`    ✓ ${what}`) }

async function firstTrade() {
  const w = victim(1)
  say('T01 T02', `${w.name}'s account, network, pair and its wallet / available / reserved / withdrawable balances`)
  show(await cli(w.index, ['status']))
  const b = await openBatch(50n)
  say('T03 T04 T05', `${w.name} reviews selling 10 token0 for at least 9 token1 in batch ${b}: limit, fee, deposit, funding and deadlines; nothing is sent`)
  show(await cli(w.index, ['commit', 'sell', '10', '9', '--dry-run']))
  say('T05 T07', 'it commits: the client deposits the shortfall, then publishes only ciphertext')
  show(await cli(w.index, ['commit', 'sell', '10', '9']))
  say('T10', `${w.name} goes offline. After batch ${b}'s drand round the keeper decrypts and reveals the order without its state or signature`)
  await revealBatch(b, 1)
  say('T11', 'the solver settles the batch at one clearing price')
  await settleBatch(b)
  const [c] = await trackBatch(w, b)
  console.log(`    #${c.id} batch ${c.batch}: ${c.state} (${c.what}) ${c.fill}`)
  expect(c.state === 'filled', `order #${c.id} filled`)
  say('T11 T14', 'proceeds and the deposit (less the keeper\'s bounty) are in the vault; nothing blocks withdrawal, so it all goes back to the wallet')
  show(await cli(w.index, ['status']))
  await withdrawAll(w)
}

async function repeat() {
  const w = victim(2)
  for (const t of ['token0', 'token1']) show(await cli(w.index, ['deposit', t, '12']))
  const b = await openBatch(50n)
  say('T08', `${w.name} places two orders in batch ${b} from one funded account; the second preflight counts the first's reservation`)
  show(await cli(w.index, ['commit', 'sell', '5', '4.5']))
  show(await cli(w.index, ['commit', 'buy', '5', '4.5']))
  await revealBatch(b, 2)
  await settleBatch(b)
  for (const c of await trackBatch(w, b)) console.log(`    #${c.id}: ${c.state} (${c.what}) ${c.fill}`)
  say('T14', `${w.name} trades again from the vault proceeds, without a wallet round trip`)
  const before = await walletTokens(account(w.index).address)
  const b2 = await openBatch(50n)
  show(await cli(w.index, ['commit', 'sell', '5', '4.5']))
  const after = await walletTokens(account(w.index).address)
  expect(before[0] === after[0] && before[1] === after[1], 'no tokens left the wallet: the vault funded the order')
  await revealBatch(b2, 1)
  await settleBatch(b2)
  for (const c of await trackBatch(w, b2)) console.log(`    #${c.id}: ${c.state} (${c.what}) ${c.fill}`)
  await withdrawAll(w)
}

async function restore() {
  const w = victim(3)
  const owner = account(w.index).address
  const b = await openBatch(50n)
  say('T15', `${w.name} commits in batch ${b}; the client writes an encrypted backup after the change`)
  show(await cli(w.index, ['commit', 'sell', '10', '9']))
  const backups = here('.state/backups')
  console.log(`    backups: ${existsSync(backups) ? readdirSync(backups).filter((f) => f.toLowerCase().includes(owner.slice(2).toLowerCase())).join(', ') : 'none'}`)
  say('T15', 'the device is lost: its private state (orders and salts) is deleted')
  const dep = deployment()
  rmSync(join(here('.state/client'), `${dep.chainId}-${dep.settlement}-${owner}.json`.toLowerCase()), { force: true })
  show(await cli(w.index, ['track']))
  say('T15', 'restore-backup decrypts with the same wallet, checks each order against the chain and imports it')
  show(await cli(w.index, ['restore-backup']))
  say('T10 T12', `no keeper this time: once batch ${b}'s reveal window opens, ${w.name} reveals its own order with cleanup and keeps the bounty`)
  await waitUntil(await read('revealOpens', [b]), `batch ${b}'s reveal window`)
  show(await cli(w.index, ['cleanup']))
  await settleBatch(b)
  for (const c of await trackBatch(w, b)) console.log(`    #${c.id}: ${c.state} (${c.what}) ${c.fill}`)
  await withdrawAll(w)
}

async function noFill() {
  const w = victim(4)
  const other = victim(1)
  // Fund before choosing the batch: live approvals and deposits can consume most of a short commit window.
  for (const [who, token, amount] of [[w, 'token0', '10'], [w, 'token1', '1'], [other, 'token1', '11']]) {
    show(await cli(who.index, ['deposit', token, amount]))
  }
  const b = await openBatch(50n)
  say('T03 T11', `${w.name} sells 10 token0 but insists on at least 20 token1, which no price in batch ${b} gives; ${other.name}'s order trades alongside`)
  show(await cli(w.index, ['commit', 'sell', '10', '20']))
  show(await cli(other.index, ['commit', 'buy', '10', '9']))
  await revealBatch(b, 2)
  await settleBatch(b)
  const [c] = await trackBatch(w, b)
  console.log(`    #${c.id}: ${c.state} (${c.what})`)
  expect(c.state !== 'filled', `${w.name}'s order #${c.id} did not fill at its limit (${c.state})`)
  say('T13', 'resubmit names the original order, the new batch and the new commit fee; dry run, nothing sent')
  show(await cli(w.index, ['resubmit', '--slippage', 'keep', '--dry-run']))
  say('T12 T14', 'the unfilled input is unlocked: cleanup closes anything left and everything withdraws')
  show(await cli(w.index, ['cleanup']))
  await withdrawAll(w)
  await withdrawAll(other)
}

async function outage() {
  const w = victim(5)
  let b = await openBatch(50n)
  say('O03', `the solver is down. ${w.name} commits in batch ${b}; the keeper reveals it`)
  show(await cli(w.index, ['commit', 'sell', '10', '9']))
  await revealBatch(b, 1)
  const closes = await read('revealCloses', [b])
  await waitUntil(closes + 2n, 'the settle window')
  let { st } = await keeperOnce({ KEEPER_SETTLE_GRACE_S: '15' })
  console.log(`    inside the 15 s grace period the keeper leaves it to the solver: settle due ${st?.due?.settle ?? '?'}`)
  await waitUntil(closes + 16n, 'the grace period to pass')
  ;({ st } = await keeperOnce({ KEEPER_SETTLE_GRACE_S: '15' }))
  console.log(`    past it, the keeper runs the solver's search with its own key: settled ${st?.settled ?? 0}, spent ${st?.spentWei ?? 0} wei`)
  for (const c of await trackBatch(w, b)) console.log(`    #${c.id}: ${c.state} (${c.what}) ${c.fill}`)

  b = await openBatch(50n)
  say('T10 T12', `now the keeper and the solver are both down. ${w.name} commits in batch ${b}`)
  show(await cli(w.index, ['commit', 'sell', '10', '9']))
  await waitUntil(await read('revealOpens', [b]), `batch ${b}'s reveal window`)
  say('T10', `${w.name} reveals its own order: cleanup sends the reveal itself`)
  show(await cli(w.index, ['cleanup']))
  say('T12', 'nobody settles. Cleanup says what must wait, then expires the batch after its settle window and unlocks the input')
  show(await cli(w.index, ['cleanup', '--dry-run']))
  await waitUntil(await read('settleCloses', [b]), `batch ${b}'s settle window to close`)
  show(await cli(w.index, ['cleanup']))
  for (const c of await trackBatch(w, b)) console.log(`    #${c.id}: ${c.state} (${c.what})`)
  show(await cli(w.index, ['cleanup']))
  await withdrawAll(w)
}

async function griefers() {
  const [seller, buyer] = [victim(1), victim(2)]
  const griefer = account(ROLES.sniper)
  const dep = deployment()
  // the griefer funds a commitment deposit like anyone else (demo tokens mint freely)
  const amount = await read('depositAmount')
  await pub.waitForTransactionReceipt({ hash: await wallet(account(ROLES.deployer)).writeContract({ address: dep.depositToken, abi: ERC20.abi, functionName: 'mint', args: [griefer.address, amount] }) })
  show(await cli(ROLES.sniper, ['deposit', dep.depositToken.toLowerCase() === dep.token0.toLowerCase() ? 'token0' : 'token1', String(Number(amount) / 1e18)]))
  for (const [who, token, value] of [[seller, 'token0', '10'], [seller, 'token1', '1'], [buyer, 'token1', '11']]) {
    show(await cli(who.index, ['deposit', token, value]))
  }
  const b = await openBatch(50n)
  say('O01', `in batch ${b}, ${seller.name} and ${buyer.name} commit real crossing orders; the griefer commits random bytes`)
  show(await cli(seller.index, ['commit', 'sell', '10', '9']))
  show(await cli(buyer.index, ['commit', 'buy', '10', '9']))
  const garbage = toHex(crypto.getRandomValues(new Uint8Array(200)))
  const hash = await wallet(griefer).writeContract({ address: dep.settlement, abi: SETTLEMENT.abi, functionName: 'commit', args: [b, keccak256(garbage), garbage] })
  await pub.waitForTransactionReceipt({ hash })
  console.log(`    garbage commitment: ${explorerTx(hash)}`)
  const vaultBefore = await pub.readContract({ address: dep.vault, abi: VAULT.abi, functionName: 'balanceOf', args: [griefer.address, dep.depositToken] })
  await revealBatch(b, 2)
  say('O02', 'a malicious solver proposes a clearing price 50% above the pool\'s')
  await waitUntil(await read('revealCloses', [b]), `batch ${b}'s settle window`)
  const bad = (await read('poolPriceX96')) * 3n / 2n
  const call = { address: dep.settlement, abi: SETTLEMENT.abi, functionName: 'settle', args: [b, bad] }
  const reason = await pub.simulateContract({ account: griefer, ...call }).then(() => 'nothing?!', (e) => e.walk?.((x) => x.data?.errorName)?.data?.errorName ?? e.shortMessage)
  const badTx = await wallet(griefer).writeContract({ ...call, gas: 3_000_000n }) // fixed gas: land the revert onchain
  const rc = await pub.waitForTransactionReceipt({ hash: badTx })
  console.log(`    ${rc.status === 'success' ? 'ACCEPTED?!' : `reverted ${reason}`}: ${explorerTx(badTx)}`)
  expect(rc.status !== 'success', 'the bad price reverted and the batch is untouched')
  say('O02', 'the honest solver settles the same batch')
  await settleBatch(b)
  for (const w of [seller, buyer]) for (const c of await trackBatch(w, b)) console.log(`    ${w.name} #${c.id}: ${c.state} (${c.what}) ${c.fill}`)
  say('O01', 'after the reveal window the keeper slashes the commitment nobody could open')
  const { st } = await keeperOnce()
  console.log(`    keeper: slashed ${st?.slashed ?? 0}${st?.errors?.length ? `, errors ${st.errors.join('; ')}` : ''}`)
  const vaultAfter = await pub.readContract({ address: dep.vault, abi: VAULT.abi, functionName: 'balanceOf', args: [griefer.address, dep.depositToken] })
  console.log(`    griefer's vault deposit token: ${vaultBefore} -> ${vaultAfter} (the deposit is forfeit)`)
  for (const w of [seller, buyer]) await withdrawAll(w)
}

const scenarios = { 'first-trade': firstTrade, repeat, restore, 'no-fill': noFill, outage, griefers }
const name = process.argv[2]
if (name !== 'all' && !scenarios[name]) {
  console.error(`usage: npm run scenario -- ${[...Object.keys(scenarios), 'all'].join(' | ')}`)
  process.exit(2)
}
console.log(`chain ${chain.id}, settlement ${deployment().settlement}, chain time ${await chainNow()}`)
for (const [k, run] of Object.entries(scenarios)) {
  if (name !== 'all' && name !== k) continue
  console.log(`\n\x1b[1m===== ${k} =====\x1b[0m`)
  await run()
}
process.exit(0)
