// Three anvil accounts commit to one batch, the keeper reveals, the solver settles, each user withdraws.
// Uses the recorded drand round 1000000, so the chain clock is set to that round. Do not point this at a live keeper.
import { spawn, execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { artifactPath, ROOT, TEST_MNEMONIC } from '../packages/client/lib.mjs'
import { DRAND, DEPOSIT, user } from '../packages/client/test/chain.mjs'
import { createPublicClient, createWalletClient, defineChain, http } from '../packages/client/node_modules/viem/_esm/index.js'

const GENESIS = 1692803367n
const start = Number(GENESIS + 2999691n) // batch length 300; batch 0 encrypts to recorded round 1000000
const out = process.env.CONTRACTS_OUT || join(ROOT, 'contracts/out')
const art = (name) => JSON.parse(readFileSync(artifactPath(out, name), 'utf8'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CLI = new URL('../packages/client/cli.mjs', import.meta.url).pathname
const keeper = new URL('../packages/keeper/keeper.mjs', import.meta.url).pathname
const solver = new URL('../packages/solver/solver.mjs', import.meta.url).pathname

const port = 8547
const rpc = `http://127.0.0.1:${port}`
const anvil = spawn('anvil', ['--silent', '--port', String(port), '--accounts', '20', '--timestamp', String(start)], { stdio: 'ignore' })
const chain = defineChain({ id: 31337, name: 'anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } })
const pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 50 })
const deployer = user(0)
const wallet = createWalletClient({ account: deployer, chain, transport: http(rpc) })

function say(title, extra = '') {
  console.log(`\n== ${title}${extra ? `\n${extra}` : ''}`)
}
async function hashesSince(from) {
  const to = await pub.getBlockNumber()
  const hashes = []
  for (let n = from + 1n; n <= to; n++) hashes.push(...(await pub.getBlock({ blockNumber: n })).transactions)
  for (const hash of hashes) console.log(`  ${hash}`)
  if (!hashes.length) console.log('  (no new transactions)')
  return to
}
function run(file, args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [file, ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      const text = `${stdout}${stderr}`.trim()
      if (text) console.log(text)
      resolve(error ? error.code ?? 1 : 0)
    })
  })
}

let code = 0
try {
  for (let i = 0; ; i++) {
    try { await pub.getChainId(); break } catch { if (i > 100) throw new Error('anvil did not start'); await sleep(50) }
  }
  await pub.request({ method: 'anvil_setBlockTimestampInterval', params: [0] })
  const wait = async (hash) => {
    const receipt = await pub.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`reverted ${hash}`)
    return receipt
  }
  const deploy = async (name, args = []) => (await wait(await wallet.deployContract({ abi: art(name).abi, bytecode: art(name).bytecode.object, args }))).contractAddress
  const write = async (address, name, functionName, args) => wait(await wallet.writeContract({ address, abi: art(name).abi, functionName, args }))
  let seen = 0n
  say('deploy vault, pool, settlement and external reference')
  const [ta, tb] = [await deploy('MockERC20', ['Token A', 'TKA', 18]), await deploy('MockERC20', ['Token B', 'TKB', 18])]
  const [token0, token1] = [ta, tb].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1))
  const vault = await deploy('BlindfoldVault')
  const manager = await deploy('PoolManager', [deployer.address])
  const settlement = await deploy('BlindfoldSettlement', [{
    manager, vault, depositToken: token1, depositAmount: DEPOSIT, commitFee: 0n, bountyBps: 2000n,
    treasury: user(9).address, schedule: { start, batchLength: 300, revealLength: 24, settleLength: 30 }, toleranceBps: 100n,
  }])
  await write(vault, 'BlindfoldVault', 'setOperator', [settlement])
  const pool = { currency0: token0, currency1: token1, fee: 3000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000' }
  await write(manager, 'PoolManager', 'initialize', [pool, 1n << 96n])
  await write(settlement, 'BlindfoldSettlement', 'initialize', [pool])
  const market = await deploy('MockExternalMarket', [settlement, token0, token1])
  await write(settlement, 'BlindfoldSettlement', 'configureExternal', [market])
  const dir = mkdtempSync(join(tmpdir(), 'blindfold-demo-'))
  const deployments = join(dir, 'blindfold.local.json')
  writeFileSync(deployments, JSON.stringify({
    chainId: 31337, deployBlock: 0, mode: 'local', vault, settlement, token0, token1, depositToken: token1, admission: 'off',
  }))
  seen = await hashesSince(seen)
  const baseEnv = { RPC_URL: rpc, DEPLOYMENTS: deployments, DRAND, CLIENT_STATE: join(dir, 'state'), PRIVATE_KEY: '' }
  const cli = (index, args) => run(CLI, args, { ...baseEnv, CLIENT_ACCOUNT_INDEX: String(index) })
  for (const index of [10, 11, 12]) {
    for (const token of [token0, token1]) await write(token, 'MockERC20', 'mint', [user(index).address, 100n * 10n ** 18n])
  }
  say('three accounts fund both tokens and commit to batch 0')
  const orders = [[10, 'sell', '10', '9'], [11, 'buy', '6', '5'], [12, 'buy', '4', '3']]
  for (const [index, side, amount, minimum] of orders) {
    if (await cli(index, ['deposit', 'token0', '40']) !== 0) throw new Error(`user ${index} deposit token0 failed`)
    if (await cli(index, ['deposit', 'token1', '40']) !== 0) throw new Error(`user ${index} deposit token1 failed`)
    if (await cli(index, ['commit', side, amount, minimum, '--vault-only', '--both-funded']) !== 0) throw new Error(`user ${index} commit failed`)
  }
  seen = await hashesSince(seen)
  const revealAt = await pub.readContract({ address: settlement, abi: art('BlindfoldSettlement').abi, functionName: 'revealOpens', args: [0n] })
  say('keeper reveals', `chain time set to reveal open ${revealAt}`)
  await pub.request({ method: 'evm_setNextBlockTimestamp', params: [Number(revealAt)] })
  await pub.request({ method: 'evm_mine', params: [] })
  code = await run(keeper, ['--once'], { ...baseEnv, KEEPER_INDEX: '1' })
  if (code !== 0) throw new Error('keeper failed')
  seen = await hashesSince(seen)
  const settleAt = await pub.readContract({ address: settlement, abi: art('BlindfoldSettlement').abi, functionName: 'revealCloses', args: [0n] })
  say('solver settles', `chain time set to settle open ${settleAt}`)
  await pub.request({ method: 'evm_setNextBlockTimestamp', params: [Number(settleAt)] })
  await pub.request({ method: 'evm_mine', params: [] })
  code = await run(solver, ['--once', '--json'], { ...baseEnv, SOLVER_INDEX: '2' })
  seen = await hashesSince(seen)
  if (code !== 0) throw new Error('solver failed')
  say('each account withdraws')
  for (const index of [10, 11, 12]) {
    if (await cli(index, ['withdraw', 'token0', 'all']) !== 0) throw new Error(`user ${index} withdraw token0 failed`)
    if (await cli(index, ['withdraw', 'token1', 'all']) !== 0) throw new Error(`user ${index} withdraw token1 failed`)
  }
  await hashesSince(seen)
  say('done', 'three accounts committed, the keeper revealed, the solver settled, and each account withdrew')
} catch (error) {
  console.error(`\nFAIL  ${error.message}`)
  code = 1
} finally {
  anvil.kill()
}
process.exit(code)
