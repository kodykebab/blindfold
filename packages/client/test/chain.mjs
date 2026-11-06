// Test-only local chain: its own anvil, the auction contracts from contracts/out, and a deployments file.
// No pool is needed for commit, reveal, slash, expire and withdraw, so the settlement points at a dummy manager.
import { spawn, execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, defineChain, http } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { ROOT, TEST_MNEMONIC, artifactPath } from '../lib.mjs'
import { readFileSync } from 'node:fs'

const out = process.env.CONTRACTS_OUT || join(ROOT, 'contracts/out')
const art = (name) => JSON.parse(readFileSync(name === 'AdmittedSettlement'
  ? join(out, 'FeesAndTiming.t.sol', 'AdmittedSettlement.json') : artifactPath(out, name), 'utf8'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url))
export const DRAND = fileURLToPath(new URL('./fixtures/drand.json', import.meta.url))
export const DEPOSIT = 5n * 10n ** 18n
export const user = (i) => mnemonicToAccount(TEST_MNEMONIC, { addressIndex: i })

export async function localChain({ timestamp, schedule = {}, settlementContract = 'BlindfoldSettlement', fee = 0n } = {}) {
  const port = await new Promise((r) => { const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)) }) })
  const rpc = `http://127.0.0.1:${port}`
  const args = ['--silent', '--port', String(port), '--accounts', '20']
  if (timestamp) args.push('--timestamp', String(timestamp))
  const anvil = spawn('anvil', args, { stdio: 'ignore' })
  const chain = defineChain({ id: 31337, name: 'anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } })
  const pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 20 })
  const deployer = user(0)
  const wallet = createWalletClient({ account: deployer, chain, transport: http(rpc) })
  for (let i = 0; ; i++) {
    try { await pub.getChainId(); break } catch { if (i > 100) throw new Error('anvil did not start'); await sleep(50) }
  }
  const wait = async (hash) => {
    const r = await pub.waitForTransactionReceipt({ hash })
    if (r.status !== 'success') throw new Error(`reverted ${hash}`)
    return r
  }
  const deploy = async (name, a = []) => (await wait(await wallet.deployContract({ abi: art(name).abi, bytecode: art(name).bytecode.object, args: a }))).contractAddress
  const write = async (address, name, functionName, a, account = deployer) =>
    wait(await createWalletClient({ account, chain, transport: http(rpc) }).writeContract({ address, abi: art(name).abi, functionName, args: a }))
  const read = (address, name, functionName, a = []) => pub.readContract({ address, abi: art(name).abi, functionName, args: a })

  const [ta, tb] = [await deploy('MockERC20', ['Token A', 'TKA', 18]), await deploy('MockERC20', ['Token B', 'TKB', 18])]
  const [token0, token1] = [ta, tb].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1))
  const vault = await deploy('BlindfoldVault')
  const deployBlock = await pub.getBlockNumber()
  const now = (await pub.getBlock()).timestamp
  const s = { start: Number(now - (now - 1692803367n) % 3n), batchLength: 30, revealLength: 24, settleLength: 30, ...schedule }
  const settlement = await deploy(settlementContract, [{
    manager: '0x000000000000000000000000000000000000dEaD', vault, depositToken: token1, depositAmount: DEPOSIT,
    commitFee: fee, bountyBps: 2000n, treasury: user(9).address, schedule: s, toleranceBps: 100n,
  }])
  await write(vault, 'BlindfoldVault', 'setOperator', [settlement])
  await write(settlement, 'BlindfoldSettlement', 'initialize', [{ currency0: token0, currency1: token1, fee: 3000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000' }])

  const dir = mkdtempSync(join(tmpdir(), 'blindfold-client-'))
  const deployments = join(dir, 'blindfold.local.json')
  writeFileSync(deployments, JSON.stringify({ chainId: 31337, deployBlock: Number(deployBlock), mode: 'local', vault, settlement, token0, token1, depositToken: token1, admission: 'off' }))

  return {
    rpc, pub, dir, deployments, vault, settlement, token0, token1, read, write,
    mint: (to, token, amount) => write(token, 'MockERC20', 'mint', [to, amount]),
    warp: async (t) => {
      await pub.request({ method: 'evm_setNextBlockTimestamp', params: [Number(t)] })
      await pub.request({ method: 'evm_mine', params: [] })
    },
    /** Run the real CLI as user i; resolves {code, out, err}. */
    cli: (i, args, env = {}) => new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], {
        env: { ...process.env, RPC_URL: rpc, DEPLOYMENTS: deployments, USER: String(i), DRAND, CLIENT_STATE: join(dir, 'state'), ...env },
      }, (e, out, err) => resolve({ code: e ? e.code : 0, out, err }))
    }),
    stop: () => anvil.kill(),
  }
}
