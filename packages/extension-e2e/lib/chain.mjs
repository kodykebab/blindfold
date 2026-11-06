// Local anvil for the e2e harness: fixed port 8563, the auction contracts from contracts/out, a deployments file.
// Same deployment as packages/client/test/chain.mjs, plus a real v4 PoolManager and pool at price 1, so a batch of
// crossing orders can settle with no residual swap (E2). Admission mode (E3) adds the verifiers and the hook.
import { createServer } from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, defineChain, getCreate2Address, http, toHex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
export const PORT = 8563
export const RPC = `http://127.0.0.1:${PORT}`
// anvil's public test mnemonic; accounts 10-19 are users. Never use it on a real chain.
export const TEST_MNEMONIC = 'test test test test test test test test test test test junk'
export const user = (i) => mnemonicToAccount(TEST_MNEMONIC, { addressIndex: i })
export const DEPOSIT = 5n * 10n ** 18n
export const Q96 = 1n << 96n
export const chain = defineChain({ id: 31337, name: 'anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } })
const OUT = process.env.CONTRACTS_OUT || join(ROOT, 'contracts/out')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** client lib.mjs artifactPath: prefer the v4-compatible 0.8.26 build when Foundry made several. */
function artifact(name) {
  const dir = join(OUT, `${name}.sol`)
  for (const f of [`${name}.0.8.26.json`, `${name}.json`]) if (existsSync(join(dir, f))) return JSON.parse(readFileSync(join(dir, f), 'utf8'))
  const files = readdirSync(dir).filter((f) => f.startsWith(`${name}.`) && f.endsWith('.json'))
  if (files.length !== 1) throw new Error(`select an explicit artifact for ${name}; found ${files.length}`)
  return JSON.parse(readFileSync(join(dir, files[0]), 'utf8'))
}
export const abi = (name) => artifact(name).abi

/** forge build, unless the artifacts are there; the team lock keeps two agents from building at once. */
export async function ensureBuilt(names = ['MockERC20', 'BlindfoldVault', 'BlindfoldSettlement', 'PoolManager']) {
  // forge test can overwrite helper artifacts with Foundry-only dynamic linking bytecode. These cannot be
  // deployed on anvil even when the artifact exists (AdmissionPoolFactory.deployHook calls the Vm address).
  const deployable = () => names.every((n) => existsSync(join(OUT, `${n}.sol`))
    && !artifact(n).bytecode.object.toLowerCase().includes('7109709ecfa91a80626ff3989d68f67f5b1dd12d'))
  if (deployable()) return
  const lock = join(ROOT, 'extension-team/.forge.lock')
  for (let i = 0; existsSync(lock); i++) {
    if (i > 600) throw new Error(`${lock} held for 20 minutes`)
    await sleep(2000)
  }
  writeFileSync(lock, `agent 3 extension-e2e pid ${process.pid}\n`, { flag: 'wx' })
  try {
    execFileSync('forge', ['build', '--no-dynamic-test-linking'], { cwd: join(ROOT, 'contracts'), stdio: 'inherit' })
    if (!deployable()) throw new Error('Foundry artifacts still contain test-only bytecode after forge build')
  } finally {
    rmSync(lock, { force: true })
  }
}

/**
 * Start anvil on 8563 and deploy. admission: {params, manifestSha256} for AdmittedSettlement (E3); timestamp: anvil's start time.
 * Returns the deployment plus helpers; dep is what the extension imports (D5 shape, client chain.mjs).
 */
export async function startChain({ admission, schedule = {}, timestamp, timestampInterval, dir = join(fileURLToPath(new URL('..', import.meta.url)), '.chain') } = {}) {
  await ensureBuilt(admission ? ['MockERC20', 'AdmissionVault', 'AdmittedSettlement', 'PoolManager', 'AdmissionPoolFactory'] : undefined)
  // Refuse an occupied port before sending any deployment transaction to an unrelated chain.
  await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', () => reject(new Error(`port ${PORT} already in use; stop the other local test stack first`)))
    probe.listen(PORT, '127.0.0.1', () => probe.close(resolve))
  })
  const args = ['--silent', '--port', String(PORT), '--accounts', '20', '--gas-limit', '300000000']
  if (timestamp) args.push('--timestamp', String(timestamp)) // E3: a past start whose drand round is recorded
  const anvil = spawn('anvil', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  anvil.stderr.on('data', (b) => { stderr += b })
  const exited = new Promise((r) => anvil.once('exit', r))
  const stop = async () => { anvil.kill(); await exited }
  const pub = createPublicClient({ chain, transport: http(RPC), pollingInterval: 50 })
  try {
    for (let i = 0; ; i++) {
      if (anvil.exitCode !== null) throw new Error(`anvil exited: ${stderr.trim() || `is port ${PORT} taken?`}`)
      try { await pub.getChainId(); break } catch { if (i > 200) throw new Error('anvil did not start'); await sleep(50) }
    }
    if (timestampInterval != null) await pub.request({ method: 'anvil_setBlockTimestampInterval', params: [timestampInterval] })
    const deployer = user(0)
    const walletOf = (account) => createWalletClient({ account, chain, transport: http(RPC) })
    const wait = async (hash) => {
      const r = await pub.waitForTransactionReceipt({ hash })
      if (r.status !== 'success') throw new Error(`reverted ${hash}`)
      return r
    }
    const deployRaw = async (a, args = []) => (await wait(await walletOf(deployer).deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }))).contractAddress
    const deploy = (name, args) => deployRaw(artifact(name), args)
    const write = async (address, name, functionName, args, account = deployer) =>
      wait(await walletOf(account).writeContract({ address, abi: abi(name), functionName, args }))
    const read = (address, name, functionName, args = []) => pub.readContract({ address, abi: abi(name), functionName, args })

    const [ta, tb] = [await deploy('MockERC20', ['Token A', 'TKA', 18]), await deploy('MockERC20', ['Token B', 'TKB', 18])]
    const [token0, token1] = [ta, tb].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1))
    const vault = await deploy(admission ? 'AdmissionVault' : 'BlindfoldVault', admission ? [token0, token1] : [])
    const deployBlock = await pub.getBlockNumber()
    const now = (await pub.getBlock()).timestamp
    // long batches: a UI-driven commit must not straddle a batch boundary; the tests warp between phases
    const s = { start: Number(now - (now - 1692803367n) % 3n), batchLength: 300, revealLength: 60, settleLength: 60, ...schedule }
    const manager = await deploy('PoolManager', [deployer.address])
    const verifiers = []
    if (admission) {
      for (const mode of ['preparation', 'online']) {
        verifiers.push(await deployRaw(JSON.parse(readFileSync(join(admission.params, 'out', `${mode}.sol`, 'Verifier.json'), 'utf8'))))
      }
    }
    const contract = admission ? 'AdmittedSettlement' : 'BlindfoldSettlement' // admission also needs a nonzero commit fee
    const settlement = await deploy(contract, [{
      manager, vault, depositToken: token1, depositAmount: DEPOSIT,
      commitFee: admission ? 1n : 0n, bountyBps: 2000n, treasury: user(9).address, schedule: s, toleranceBps: 100n,
    }, ...verifiers])
    await write(vault, 'BlindfoldVault', 'setOperator', [settlement])
    let hooks = '0x0000000000000000000000000000000000000000'
    if (admission) { // client chain.mjs: mine a hook address with the admission flags
      const factory = await deploy('AdmissionPoolFactory')
      const bytecodeHash = await read(factory, 'AdmissionPoolFactory', 'initCodeHash', [manager, settlement])
      let salt
      for (let i = 0n; i < 500000n && !salt; i++) {
        const candidate = getCreate2Address({ from: factory, salt: toHex(i, { size: 32 }), bytecodeHash })
        if ((BigInt(candidate) & 16383n) === 128n) { hooks = candidate; salt = toHex(i, { size: 32 }) }
      }
      if (!salt) throw new Error('could not mine local hook salt')
      await write(factory, 'AdmissionPoolFactory', 'deployHook', [manager, settlement, salt])
    }
    const pool = { currency0: token0, currency1: token1, fee: 3000, tickSpacing: 60, hooks }
    await write(manager, 'PoolManager', 'initialize', [pool, Q96]) // sqrtPriceX96 = 2^96: price 1
    await write(settlement, contract, 'initialize', [pool])

    const dep = {
      chainId: 31337, deployBlock: Number(deployBlock), mode: 'local', rpc: RPC, vault, settlement, token0, token1, depositToken: token1,
      admission: admission ? { manifestSha256: admission.manifestSha256, preparationVerifier: verifiers[0], onlineVerifier: verifiers[1] } : 'off',
    }
    mkdirSync(dir, { recursive: true })
    const depFile = join(dir, 'blindfold.local.json')
    writeFileSync(depFile, JSON.stringify(dep, null, 2))
    return {
      dep, depFile, pub, read, write, contract, manager, stop,
      mint: (to, token, amount) => write(token, 'MockERC20', 'mint', [to, amount]),
      /** Set the next block's time and mine it. */
      warp: async (t) => {
        await pub.request({ method: 'evm_setNextBlockTimestamp', params: [Number(t)] })
        await pub.request({ method: 'evm_mine', params: [] })
      },
      automine: (on) => pub.request({ method: 'evm_setAutomine', params: [on] }),
      mine: () => pub.request({ method: 'evm_mine', params: [] }),
    }
  } catch (e) {
    await stop()
    throw e
  }
}
