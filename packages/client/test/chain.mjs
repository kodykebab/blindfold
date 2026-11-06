// Test-only local chain: its own anvil, the auction contracts from contracts/out, and a deployments file.
// No pool is needed for commit, reveal, slash, expire and withdraw, so the settlement points at a dummy manager.
import { spawn, execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, defineChain, http, getCreate2Address, toHex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { ROOT, TEST_MNEMONIC, artifactPath } from '../lib.mjs'
import { readFileSync } from 'node:fs'

const out = process.env.CONTRACTS_OUT || join(ROOT, 'contracts/out')
const art = (name) => JSON.parse(readFileSync(name === 'ReleasePolicySettlement'
  ? join(out, 'FeesAndTiming.t.sol', 'ReleasePolicySettlement.json') : artifactPath(out, name), 'utf8'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url))
export const DRAND = fileURLToPath(new URL('./fixtures/drand.json', import.meta.url))
export const DEPOSIT = 5n * 10n ** 18n
export const user = (i) => mnemonicToAccount(TEST_MNEMONIC, { addressIndex: i })

// v4: deploy a real PoolManager and sealed hook with admission off too (admission always has them).
export async function localChain({ timestamp, schedule = {}, settlementContract = 'BlindfoldSettlement', fee = 0n, admission, configureMarket = true, timestampInterval, v4 = false } = {}) {
  const port = await new Promise((r) => { const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)) }) })
  const rpc = `http://127.0.0.1:${port}`
  const args = ['--silent', '--port', String(port), '--accounts', '20', '--gas-limit', '300000000']
  if (timestamp) args.push('--timestamp', String(timestamp))
  const anvil = spawn('anvil', args, { stdio: 'ignore' })
  const chain = defineChain({ id: 31337, name: 'anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } })
  const pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 20 })
  const deployer = user(0)
  const wallet = createWalletClient({ account: deployer, chain, transport: http(rpc) })
  for (let i = 0; ; i++) {
    try { await pub.getChainId(); break } catch { if (i > 100) throw new Error('anvil did not start'); await sleep(50) }
  }
  // Recorded-round fixtures may advance one second per mined block while local proofs run.
  if (timestampInterval != null) await pub.request({ method: 'anvil_setBlockTimestampInterval', params: [timestampInterval] })
  const wait = async (hash) => {
    const r = await pub.waitForTransactionReceipt({ hash })
    if (r.status !== 'success') throw new Error(`reverted ${hash}`)
    return r
  }
  const deploy = async (name, a = []) => (await wait(await wallet.deployContract({ abi: art(name).abi, bytecode: art(name).bytecode.object, args: a }))).contractAddress
  const write = async (address, name, functionName, a, account = deployer) =>
    wait(await createWalletClient({ account, chain, transport: http(rpc) }).writeContract({ address, abi: art(name).abi, functionName, args: a }))
  const read = (address, name, functionName, a = []) => pub.readContract({ address, abi: art(name).abi, functionName, args: a })

  try {
  const [ta, tb] = [await deploy('MockERC20', ['Token A', 'TKA', 18]), await deploy('MockERC20', ['Token B', 'TKB', 18])]
  const [token0, token1] = [ta, tb].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1))
  const vault = await deploy(admission ? 'AdmissionVault' : 'BlindfoldVault', admission ? [token0, token1] : [])
  const deployBlock = await pub.getBlockNumber()
  const now = (await pub.getBlock()).timestamp
  const s = { start: Number(now - (now - 1692803367n) % 3n), batchLength: 30, revealLength: 24, settleLength: 30, ...schedule }
  const pool4 = Boolean(admission || v4)
  const manager = pool4 ? await deploy('PoolManager', [deployer.address]) : '0x000000000000000000000000000000000000dEaD'
  const verifiers = []
  if (admission) {
    settlementContract = 'AdmittedSettlement'
    for (const mode of ['preparation', 'online']) {
      const artifact = JSON.parse(readFileSync(join(admission.params, 'out', `${mode}.sol`, 'Verifier.json'), 'utf8'))
      verifiers.push((await wait(await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object }))).contractAddress)
    }
  }
  const config = { manager, vault, depositToken: token1, depositAmount: DEPOSIT, commitFee: fee, bountyBps: 2000n, treasury: user(9).address, schedule: s, toleranceBps: 100n }
  const settlement = await deploy(settlementContract, [config, ...verifiers])
  await write(vault, 'BlindfoldVault', 'setOperator', [settlement])
  let hooks = '0x0000000000000000000000000000000000000000'
  if (pool4) {
    const factory = await deploy('AdmissionPoolFactory')
    const bytecodeHash = await read(factory, 'AdmissionPoolFactory', 'initCodeHash', [manager, settlement])
    let salt
    for (let i = 0n; i < 500000n; i++) {
      const candidate = getCreate2Address({ from: factory, salt: toHex(i, { size: 32 }), bytecodeHash })
      if ((BigInt(candidate) & 16383n) === 128n) { hooks = candidate; salt = toHex(i, { size: 32 }); break }
    }
    if (!salt) throw new Error('could not mine local hook salt')
    await write(factory, 'AdmissionPoolFactory', 'deployHook', [manager, settlement, salt])
  }
  const pool = { currency0: token0, currency1: token1, fee: 3000, tickSpacing: 60, hooks }
  if (pool4) await write(manager, 'PoolManager', 'initialize', [pool, 1n << 96n])
  await write(settlement, settlementContract, 'initialize', [pool])
  // Admission chains add no pool liquidity; matched batches use this market for peer pricing.
  // Routing tests opt out to install their own immutable market before the first commitment.
  if (admission && configureMarket) await write(settlement, settlementContract, 'configureExternal', [await deploy('MockExternalMarket', [settlement, token0, token1])])

  const dir = mkdtempSync(join(tmpdir(), 'blindfold-client-'))
  const deployments = join(dir, 'blindfold.local.json')
  writeFileSync(deployments, JSON.stringify({ chainId: 31337, deployBlock: Number(deployBlock), mode: 'local', vault, settlement, token0, token1, depositToken: token1, admission: admission ? { manifestSha256: admission.manifestSha256, preparationVerifier: verifiers[0], onlineVerifier: verifiers[1] } : 'off',
    poolManager: pool4 ? manager : null, hook: pool4 ? hooks : null, treasury: config.treasury,
    depositAmount: String(config.depositAmount), commitFee: String(config.commitFee), bountyBps: String(config.bountyBps), toleranceBps: String(config.toleranceBps),
    schedule: { start: Number(s.start), batchLength: s.batchLength, revealLength: s.revealLength, settleLength: s.settleLength } }))

  return {
    rpc, pub, dir, deployments, vault, settlement, token0, token1, manager, hooks, pool, read, write, deploy, art,
    mint: (to, token, amount) => write(token, 'MockERC20', 'mint', [to, amount]),
    warp: async (t) => {
      await pub.request({ method: 'evm_setNextBlockTimestamp', params: [Number(t)] })
      await pub.request({ method: 'evm_mine', params: [] })
    },
    /** Run the real CLI as user i; resolves {code, out, err}. */
    cli: (i, args, env = {}) => new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], {
        env: { ...process.env, RPC_URL: rpc, DEPLOYMENTS: deployments, CLIENT_ACCOUNT_INDEX: String(i), DRAND, CLIENT_STATE: join(dir, 'state'), ...env },
      }, (e, out, err) => resolve({ code: e ? e.code : 0, out, err }))
    }),
    stop: () => anvil.kill(),
  }
  } catch (e) { anvil.kill(); throw e }
}
