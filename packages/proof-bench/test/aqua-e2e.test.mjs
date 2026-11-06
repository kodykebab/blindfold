// Real proof-bound pair orders, the unmodified keeper and solver through Aqua + v4.
// Run after forge build --no-dynamic-test-linking with AQUA_E2E=1 and the existing admission parameter env vars.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createPublicClient, createWalletClient, defineChain, http, getCreate2Address, toHex, parseEventLogs, encodeAbiParameters } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { ROOT, artifactPath } from '../../client/lib.mjs'

const exec = promisify(execFile)
const mnemonic = 'test test test test test test test test test test test junk'
const user = (i) => mnemonicToAccount(mnemonic, { addressIndex: i })
const e18 = 10n ** 18n, Q96 = 1n << 96n
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('real admission -> keeper -> solver -> Aqua/v4 fills and expiry -> withdrawals', { skip: process.env.AQUA_E2E !== '1', timeout: 600000 }, async () => {
  const params = process.env.ADMISSION_PARAMS
  assert.ok(params, 'ADMISSION_PARAMS is required')
  const manifestSha256 = createHash('sha256').update(readFileSync(join(params, 'manifest.json'))).digest('hex')
  const out = process.env.CONTRACTS_OUT || join(ROOT, 'contracts/out')
  const art = (name) => JSON.parse(readFileSync(artifactPath(out, name), 'utf8'))
  const port = await new Promise((resolve, reject) => { const srv = createServer(); srv.on('error', reject); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) }) })
  const timestamp = 1692803367n + (1000000n - 3n) * 3n - 600n
  const anvil = spawn('anvil', ['--silent', '--port', String(port), '--accounts', '20', '--timestamp', String(timestamp), '--gas-limit', '300000000'], { stdio: 'ignore' })
  const dir = mkdtempSync(join(tmpdir(), 'blindfold-aqua-'))
  const rpc = `http://127.0.0.1:${port}`
  const chain = defineChain({ id: 31337, name: 'anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } })
  const pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 20 })
  const wallet = (who = user(0)) => createWalletClient({ account: who, chain, transport: http(rpc) })
  const wait = async (hash) => { const r = await pub.waitForTransactionReceipt({ hash }); assert.equal(r.status, 'success'); return r }
  const deployArtifact = async (a, args = []) => (await wait(await wallet().deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }))).contractAddress
  const deploy = (name, args = []) => deployArtifact(art(name), args)
  const read = (address, name, functionName, args = []) => pub.readContract({ address, abi: art(name).abi, functionName, args })
  const write = (address, name, functionName, args = [], who = user(0)) => wallet(who).writeContract({ address, abi: art(name).abi, functionName, args }).then(wait)
  const warp = async (t) => { await pub.request({ method: 'evm_setNextBlockTimestamp', params: [Number(t)] }); await pub.request({ method: 'evm_mine', params: [] }) }
  try {
    for (let i = 0; ; i++) { try { await pub.getChainId(); break } catch (e) { if (i === 100) throw e; await sleep(50) } }
    const a = await deploy('MockERC20', ['A', 'TKA', 18]), b = await deploy('MockERC20', ['B', 'TKB', 18])
    const [token0, token1] = [a, b].sort((x, y) => BigInt(x) < BigInt(y) ? -1 : 1)
    const vault = await deploy('AdmissionVault', [token0, token1])
    const manager = await deploy('PoolManager', [user(0).address])
    const registry = await deploy('Aqua')
    const router = await deploy('BlindfoldAquaRouter', [registry, '0x0000000000000000000000000000000000000000', user(0).address])
    const route = await deploy('AquaResidual', [router, user(0).address, 5000n])
    const verifiers = []
    for (const mode of ['preparation', 'online']) verifiers.push(await deployArtifact(JSON.parse(readFileSync(join(params, 'out', `${mode}.sol`, 'Verifier.json'), 'utf8'))))
    const settlement = await deploy('AquaAdmittedSettlement', [{ manager, vault, depositToken: token1, depositAmount: 5n * e18, bountyBps: 2000n, treasury: user(9).address, commitFee: 1n,
      schedule: { start: timestamp, batchLength: 600, revealLength: 24, settleLength: 600 }, toleranceBps: 100n }, ...verifiers, route])
    assert.ok(((await pub.getCode({ address: settlement })).length - 2) / 2 <= 24576)
    await write(vault, 'BlindfoldVault', 'setOperator', [settlement])
    const factory = await deploy('AdmissionPoolFactory')
    const codeHash = await read(factory, 'AdmissionPoolFactory', 'initCodeHash', [manager, settlement])
    let hooks, salt
    for (let i = 0n; i < 500000n; i++) { const candidate = getCreate2Address({ from: factory, salt: toHex(i, { size: 32 }), bytecodeHash: codeHash }); if ((BigInt(candidate) & 16383n) === 128n) { hooks = candidate; salt = toHex(i, { size: 32 }); break } }
    assert.ok(hooks)
    await write(factory, 'AdmissionPoolFactory', 'deployHook', [manager, settlement, salt])
    const pool = { currency0: token0, currency1: token1, fee: 3000, tickSpacing: 60, hooks }
    await write(manager, 'PoolManager', 'initialize', [pool, Q96])
    await write(settlement, 'AquaAdmittedSettlement', 'initialize', [pool])
    const lp = await deploy('PoolModifyLiquidityTest', [manager])
    for (const token of [token0, token1]) {
      await write(token, 'MockERC20', 'mint', [user(0).address, 10n ** 27n])
      await write(token, 'MockERC20', 'approve', [lp, 10n ** 27n])
      await write(token, 'MockERC20', 'approve', [registry, 10n ** 27n])
      for (const i of [10, 11]) await write(token, 'MockERC20', 'mint', [user(i).address, 100n * e18])
    }
    await write(lp, 'PoolModifyLiquidityTest', 'modifyLiquidity', [pool, { tickLower: -60000, tickUpper: 60000, liquidityDelta: 10000n * e18, salt: toHex(0n, { size: 32 }) }, '0x'])
    const order = await read(route, 'AquaResidual', 'order', [settlement])
    const orderOutput = art('AquaResidual').abi.find((f) => f.name === 'order').outputs
    await write(registry, 'Aqua', 'ship', [router, encodeAbiParameters(orderOutput, [order]), [token0, token1], [1000n * e18, 1000n * e18]])
    const deployments = join(dir, 'blindfold.local.json')
    writeFileSync(deployments, JSON.stringify({ chainId: 31337, deployBlock: 0, settlement, vault, token0, token1, aquaRoute: route, mode: 'admitted', admission: { manifestSha256, preparationVerifier: verifiers[0], onlineVerifier: verifiers[1] } }))
    const fixture = join(ROOT, 'packages/client/test/fixtures/drand.json')
    const env = { ...process.env, CONTRACTS_OUT: out, RPC_URL: rpc, DEPLOYMENTS: deployments, DRAND: fixture, CLIENT_STATE: join(dir, 'state'), CLIENT_BACKUP_DIR: join(dir, 'backups'), QUOTE_MAX_AGE_S: 'off', ADMISSION_MANIFEST_SHA256: manifestSha256 }
    const keeperEnv = { ...env, KEEPER_SETTLE_GRACE_S: 'off', KEEPER_STATUS: join(dir, 'keeper.json'), KEEPER_BUDGET_WEI: String(100n * e18), KEEPER_MIN_BALANCE_WEI: '0' }
    const keeper = async () => { await exec(process.execPath, [join(ROOT, 'packages/keeper/keeper.mjs'), '--once'], { env: keeperEnv }); return JSON.parse(readFileSync(keeperEnv.KEEPER_STATUS, 'utf8')) }
    const cli = (i, args) => exec(process.execPath, [join(ROOT, 'packages/client/cli.mjs'), ...args], { env: { ...env, CLIENT_ACCOUNT_INDEX: String(i) }, maxBuffer: 2 ** 22 })
    // Two actual clients generate fresh proofs and fund/submit their own orders.
    assert.match((await cli(10, ['commit', 'sell', '10', '9'])).stdout, /admitted #/)
    console.log('first fresh-proof order admitted')
    assert.match((await cli(11, ['commit', 'buy', '5', '4.5'])).stdout, /admitted #/)
    console.log('second fresh-proof order admitted')
    const committed = await pub.getContractEvents({ address: settlement, abi: art('AquaAdmittedSettlement').abi, eventName: 'Committed', fromBlock: 0n })
    assert.equal(committed.length, 2)
    await warp(await read(settlement, 'AquaAdmittedSettlement', 'revealOpens', [0n]))
    const revealed = await keeper()
    assert.equal(revealed.revealed, 2)
    assert.deepEqual(revealed.errors, [])
    assert.deepEqual(revealed.waitingBeacon, [])
    assert.deepEqual(revealed.unopenable, [])
    assert.equal((await keeper()).revealed, 0, 'repeated keeper does not reveal twice')
    console.log('main keeper discovered, decrypted and revealed both orders')
    await warp(await read(settlement, 'AquaAdmittedSettlement', 'revealCloses', [0n]))
    // Reuse the freshly admitted batch to check a real service failure and its permissionless exit.
    // This chain is isolated, and the keeper is a one-shot process, so fixture time travel is safe.
    const snapshot = await pub.request({ method: 'evm_snapshot' })
    const solverEnv = { ...env, SETTLEMENT_ARTIFACT: artifactPath(out, 'BlindfoldSettlement') }
    const solve = () => exec(process.execPath, [join(ROOT, 'packages/solver/solver.mjs'), '--once'], { env: solverEnv })
    await write(token1, 'MockERC20', 'approve', [registry, 0n])
    await assert.rejects(solve(), 'missing maker allowance must stop the solver')
    assert.equal(await read(settlement, 'AquaAdmittedSettlement', 'finalized', [0n]), false)
    assert.equal(await read(vault, 'BlindfoldVault', 'lockedOf', [user(10).address, token0]), 10n * e18)
    assert.equal(await read(vault, 'BlindfoldVault', 'lockedOf', [user(11).address, token1]), 5n * e18)
    assert.equal((await pub.getContractEvents({ address: settlement, abi: art('AquaResidual').abi, fromBlock: 0n, eventName: 'AquaResidualFilled' })).length, 0)
    await warp(await read(settlement, 'AquaAdmittedSettlement', 'settleCloses', [0n]))
    const expired = await keeper()
    assert.equal(expired.expired, 1)
    assert.deepEqual(expired.errors, [])
    for (const i of [10, 11]) {
      assert.match((await cli(i, ['track'])).stdout, /: expired /)
      for (const token of ['token0', 'token1']) await cli(i, ['withdraw', token, 'all'])
      assert.equal(await read(vault, 'BlindfoldVault', 'openCommitments', [user(i).address]), 0n)
    }
    assert.equal(await read(token0, 'MockERC20', 'balanceOf', [user(10).address]), 100n * e18)
    assert.equal(await read(token1, 'MockERC20', 'balanceOf', [user(11).address]), 99n * e18 - 1n)
    assert.equal(await pub.request({ method: 'evm_revert', params: [snapshot] }), true)
    console.log('revoked allowance blocked settlement; main keeper expired the batch and both clients withdrew')
    const maker0 = await read(token0, 'MockERC20', 'balanceOf', [user(0).address])
    const maker1 = await read(token1, 'MockERC20', 'balanceOf', [user(0).address])
    const solved = await solve()
    assert.match(solved.stdout, /settled batch 0/)
    assert.equal(await read(settlement, 'AquaAdmittedSettlement', 'finalized', [0n]), true)
    assert.ok(await read(token0, 'MockERC20', 'balanceOf', [user(0).address]) > maker0)
    assert.ok(await read(token1, 'MockERC20', 'balanceOf', [user(0).address]) < maker1)
    const events = await pub.getContractEvents({ address: settlement, abi: art('AquaResidual').abi, fromBlock: 0n, eventName: 'AquaResidualFilled' })
    assert.equal(events.length, 1)
    const receipt = await pub.getTransactionReceipt({ hash: events[0].transactionHash })
    assert.equal(parseEventLogs({ abi: art('BlindfoldAquaRouter').abi, logs: receipt.logs, eventName: 'Swapped' })[0].args.taker.toLowerCase(), settlement.toLowerCase())
    for (const i of [10, 11]) {
      assert.match((await cli(i, ['track'])).stdout, /: filled /)
      for (const token of ['token0', 'token1']) await cli(i, ['withdraw', token, 'all'])
      assert.equal(await read(vault, 'BlindfoldVault', 'openCommitments', [user(i).address]), 0n)
    }
    for (const token of [token0, token1]) {
      for (const address of [settlement, route, router]) assert.equal(await read(token, 'MockERC20', 'balanceOf', [address]), 0n)
    }
    console.log(JSON.stringify({ settlement, route, gasUsed: String(receipt.gasUsed), solver: solved.stdout.trim() }))
  } finally { anvil.kill() }
})
