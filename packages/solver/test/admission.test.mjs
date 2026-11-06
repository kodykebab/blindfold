import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWalletClient, encodeErrorResult, http, parseEventLogs } from 'viem'
import { artifactPath } from '../artifacts.mjs'

const enabled = process.env.SOLVER_E2E === '1' && Boolean(process.env.ADMISSION_PARAMS)
const out = process.env.CONTRACTS_OUT || fileURLToPath(new URL('../../../contracts/out', import.meta.url))
const art = (name) => JSON.parse(readFileSync(artifactPath(out, name,
  ['RouteFactoryMock', 'RoutePoolMock'].includes(name) ? 'UniswapV3Route.t' : name), 'utf8'))

// Fresh development proofs, real generated verifiers and CLI submission; only the public pools are fixtures.
test('real admission proofs reach multi-hop solver CLI settlement and withdrawal', { skip: !enabled, timeout: 600000 }, async (t) => {
  const [{ localChain, user, DRAND }, { TEST_MNEMONIC, decrypt, drandClient }, { loadState }] = await Promise.all([
    import('../../client/test/chain.mjs'), import('../../client/lib.mjs'), import('../../client/state.mjs'),
  ])
  const manifestSha256 = process.env.ADMISSION_MANIFEST_SHA256
  assert.match(manifestSha256 ?? '', /^[0-9a-f]{64}$/)
  const timestamp = 1692803367n + (1000000n - 3n) * 3n - 900n
  const c = await localChain({ timestamp, admission: { params: process.env.ADMISSION_PARAMS, manifestSha256 },
    schedule: { batchLength: 900, settleLength: 300 }, fee: 1n })
  const previousState = process.env.CLIENT_STATE
  try {
    process.env.CLIENT_STATE = join(c.dir, 'state')
    const dep = JSON.parse(readFileSync(c.deployments, 'utf8'))
    const owner = user(10).address
    const wallet = createWalletClient({ account: user(0), chain: c.pub.chain, transport: http(c.rpc) })
    const wait = async (hash) => {
      const receipt = await c.pub.waitForTransactionReceipt({ hash })
      assert.equal(receipt.status, 'success')
      return receipt
    }
    const deploy = async (name, args = []) => (await wait(await wallet.deployContract({
      abi: art(name).abi, bytecode: art(name).bytecode.object, args,
    }))).contractAddress
    const write = async (address, name, functionName, args) => wait(await wallet.writeContract({ address, abi: art(name).abi, functionName, args }))
    const read = (address, name, functionName, args = []) => c.pub.readContract({ address, abi: art(name).abi, functionName, args })
    const solver = () => new Promise((resolve) => {
      execFile(process.execPath, [new URL('../solver.mjs', import.meta.url).pathname, '--once'], {
        env: { ...process.env, RPC_URL: c.rpc, DEPLOYMENTS: c.deployments,
          SETTLEMENT_ARTIFACT: artifactPath(out, 'AdmittedSettlement'), SOLVER_KEY: '', MNEMONIC: TEST_MNEMONIC },
        timeout: 60000,
      }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, output: stdout + stderr }))
    })
    assert.ok(((await c.pub.getCode({ address: c.settlement })).length - 2) / 2 <= 24576)
    assert.equal(await c.read(c.settlement, 'AdmittedSettlement', 'admissionRequired'), true)
    const middle = await deploy('MockERC20', ['Middle', 'M', 18])
    const factory = await deploy('RouteFactoryMock')
    const path = [c.token0, middle, c.token1], hops = []
    for (let i = 0; i < 2; i++) {
      const [a, b] = [path[i], path[i + 1]].sort((x, y) => BigInt(x) < BigInt(y) ? -1 : 1)
      const pool = await deploy('RoutePoolMock', [a, b, factory])
      await write(factory, 'RouteFactoryMock', 'setPool', [a, b, pool])
      for (const token of [a, b]) await c.mint(pool, token, 1000n * 10n ** 18n)
      hops.push({ pool, minimumLiquidity: 10n ** 17n, maximumObservationAge: 1800 })
    }
    const route = await deploy('UniswapV3Route', [c.settlement, factory, path, hops, 600, 30, 100n])
    await c.write(c.settlement, 'AdmittedSettlement', 'configureExternal', [route])
    for (const token of [c.token0, c.token1]) {
      await c.mint(owner, token, 100n * 10n ** 18n)
      await c.write(token, 'MockERC20', 'approve', [c.vault, 100n * 10n ** 18n], user(10))
      await c.write(c.vault, 'BlindfoldVault', 'deposit', [token, 100n * 10n ** 18n], user(10))
    }
    await assert.rejects(c.write(c.settlement, 'AdmittedSettlement', 'commit', [0n, `0x${'00'.repeat(32)}`, '0x01'], user(10)))
    // Same-side orders force a public residual instead of the solver's preferred peer-only match.
    for (const args of [['sell', '1', '0.9'], ['sell', '0.25', '0.225']]) {
      const result = await c.cli(10, ['commit', ...args])
      assert.equal(result.code, 0, result.err)
      assert.match(result.out, /admitted #/)
      t.diagnostic(`real proof-backed ${args[0]} ${args[1]} admitted`)
    }
    const state = loadState(dep, owner)
    assert.equal(state.admission.step, 2n)
    assert.deepEqual(state.admission.totals, [125n * 10n ** 16n, 0n])
    assert.equal(await c.read(c.settlement, 'AdmittedSettlement', 'fundingRoot', [owner]), state.admission.root)
    const batch = state.commitments[0].batchId
    const logs = await c.pub.getLogs({ address: c.settlement, fromBlock: BigInt(dep.deployBlock), toBlock: 'latest' })
    const commits = parseEventLogs({ abi: art('AdmittedSettlement').abi, logs, eventName: 'Committed' })
    assert.equal(commits.length, 2)
    await c.warp(await c.read(c.settlement, 'AdmittedSettlement', 'revealOpens', [batch]))
    for (const event of commits) {
      assert.equal(event.args.round, 1000000n)
      const plaintext = await decrypt(event.args.ciphertext, drandClient(DRAND))
      const saved = state.commitments.find((x) => x.id === event.args.commitId)
      assert.deepEqual(plaintext, { order: saved.order, salt: saved.salt })
      await c.write(c.settlement, 'AdmittedSettlement', 'reveal', [event.args.commitId, plaintext.order, plaintext.salt], user(11))
    }
    await c.warp(await c.read(c.settlement, 'AdmittedSettlement', 'revealCloses', [batch]))
    // An unavailable oracle must not cause a stored-price fallback or consume the accepted orders.
    await write(hops[1].pool, 'RoutePoolMock', 'setOracle', [0, 0, 0, 10n ** 18n])
    const rejected = await solver()
    assert.notEqual(rejected.code, 0, rejected.output)
    const staleSelector = encodeErrorResult({ abi: art('UniswapV3Market').abi, errorName: 'StaleObservation' })
    assert.ok(rejected.output.includes('StaleObservation') || rejected.output.includes(staleSelector), rejected.output)
    assert.equal(await c.read(c.settlement, 'AdmittedSettlement', 'finalized', [batch]), false)
    assert.equal(await c.read(c.vault, 'BlindfoldVault', 'openCommitments', [owner]), 2n)
    for (const [i, token] of [c.token0, c.token1].entries()) {
      assert.equal(await c.read(c.vault, 'BlindfoldVault', 'lockedOf', [owner, token]), state.admission.totals[i])
    }
    await write(hops[1].pool, 'RoutePoolMock', 'setOracle', [0, 0, Number((await c.pub.getBlock()).timestamp), 10n ** 18n])
    const firstBlock = await c.pub.getBlockNumber({ cacheTime: 0 })
    const result = await solver()
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /public-pool residual route/)
    t.diagnostic(result.output.trim())
    const settledLogs = await c.pub.getLogs({ address: c.settlement, fromBlock: firstBlock, toBlock: 'latest' })
    const fills = parseEventLogs({ abi: art('AdmittedSettlement').abi, logs: settledLogs, eventName: 'Filled' })
    const settlements = parseEventLogs({ abi: art('AdmittedSettlement').abi, logs: settledLogs, eventName: 'Settled' })
    assert.equal(settlements.length, 1)
    assert.equal(settlements[0].args.solver.toLowerCase(), user(2).address.toLowerCase())
    assert.ok(settlements[0].args.residualIn > 0n)
    assert.equal(fills.length, 2)
    const bounty = (await c.read(c.settlement, 'AdmittedSettlement', 'depositAmount'))
      * (await c.read(c.settlement, 'AdmittedSettlement', 'bountyBps')) / 10000n
    const totalBounty = BigInt(commits.length) * bounty
    assert.equal(await c.read(c.vault, 'BlindfoldVault', 'balanceOf', [user(11).address, c.token1]), totalBounty)
    const expected = [100n * 10n ** 18n, 100n * 10n ** 18n - 2n - totalBounty]
    for (const { args: fill } of fills) {
      const { order } = state.commitments.find((x) => x.id === fill.id)
      assert.equal(fill.amountIn, order.amountIn)
      assert.ok(fill.amountOut * order.amountIn >= order.minAmountOut * fill.amountIn)
      const input = order.zeroForOne ? 0 : 1
      expected[input] -= fill.amountIn
      expected[1 - input] += fill.amountOut
    }
    assert.equal(await c.read(c.settlement, 'AdmittedSettlement', 'finalized', [batch]), true)
    assert.equal(await c.read(c.vault, 'BlindfoldVault', 'openCommitments', [owner]), 0n)
    assert.deepEqual(await c.read(c.settlement, 'AdmittedSettlement', 'admissionState', [owner]), [0n, `0x${'00'.repeat(32)}`, 0n])
    assert.equal(await c.read(c.vault, 'BlindfoldVault', 'balanceOf', [user(9).address, c.token1]), 2n)
    const adapters = [route, await read(route, 'UniswapV3Route', 'markets', [0n]), await read(route, 'UniswapV3Route', 'markets', [1n])]
    for (const adapter of adapters) for (const token of path) assert.equal(await c.read(token, 'MockERC20', 'balanceOf', [adapter]), 0n)
    for (const [i, token] of [c.token0, c.token1].entries()) {
      assert.equal(await c.read(c.vault, 'BlindfoldVault', 'freeBalance', [owner, token]), expected[i])
      assert.equal(await c.read(c.vault, 'BlindfoldVault', 'lockedOf', [owner, token]), 0n)
      const withdrawn = await c.cli(10, ['withdraw', i === 0 ? 'token0' : 'token1', 'all'])
      assert.equal(withdrawn.code, 0, withdrawn.err)
      assert.equal(await c.read(token, 'MockERC20', 'balanceOf', [owner]), expected[i])
      assert.equal(await c.read(c.vault, 'BlindfoldVault', 'balanceOf', [owner, token]), 0n)
    }
  } finally {
    c.stop()
    if (previousState === undefined) delete process.env.CLIENT_STATE; else process.env.CLIENT_STATE = previousState
  }
})
