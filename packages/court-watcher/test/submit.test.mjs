import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContractFunctionRevertedError, encodeAbiParameters, encodeErrorResult, keccak256 } from 'viem'
import { claimArgs, createSubmitter, loadReceipts, poolKeyOf } from '../submit.mjs'

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../../../contracts/test/court/fixtures/${name}.json`, import.meta.url), 'utf8'))

test('claimArgs maps a prove.mjs claim file to the verifier Claim, with or without an L1 anchor', () => {
  const f = fixture('v4')
  const c = claimArgs(f)
  assert.equal(c.victim.index, BigInt(f.victim.index))
  assert.equal(c.back.logIndex, BigInt(f.back.logIndex))
  assert.deepEqual(c.front.txProof, f.front.txProof)
  assert.equal(c.poolId, f.poolId)
  assert.equal(c.anchor.header, f.anchor.header)
  assert.deepEqual(c.anchor.storageProof, f.anchor.storageProof)
  const { anchor, ...local } = f
  assert.deepEqual(claimArgs(local).anchor, { header: '0x', accountProof: [], storageProof: [] }, 'BLOCKHASH path')
})

test('poolKeyOf rebuilds the v4 PoolKey from the Initialize log and checks it hashes to the pool id', async () => {
  // the real v4 fixture's pool: ETH / 0x373c…, zero fee, spacing 60, hooked (as BondRegistry.t.sol's _v4Key)
  const f = fixture('v4')
  const topic = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0')
  const log = (hooks) => ({
    topics: ['0xinit', f.poolId, topic('0x0000000000000000000000000000000000000000'), topic('0x373C863E4C34Db35B58C98Dd15a018E1ab53F6ea')],
    data: encodeAbiParameters(
      [{ type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }],
      [0, 60, hooks, 2n ** 96n, 0],
    ),
  })
  const item = { v4: true, pool: f.pool, poolId: f.poolId }
  let asked
  const call = (hooks) => async (method, params) => {
    asked = params[0]
    return [log(hooks)]
  }
  const key = await poolKeyOf(call('0x15e5E7206C661a1E881F5CD33A94eAF2328FA8cc'), item)
  assert.equal(keccak256(key), f.poolId)
  assert.equal(asked.topics[1], f.poolId, 'asks for this pool only')
  await assert.rejects(poolKeyOf(call('0x' + '00'.repeat(20)), item), /does not hash/)
})

test('poolKeyOf reads token0, token1 and fee for a v3 pool', async () => {
  const word = (x) => '0x' + x.toString(16).padStart(64, '0')
  const answers = { '0x0dfe1681': word(0xa0n), '0xd21220a7': word(0xb0n), '0xddca3f43': word(500n) } // token0/token1/fee
  const key = await poolKeyOf(async (m, [{ data }]) => answers[data], { v4: false, pool: '0x' + '77'.repeat(20) })
  const want = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }],
    ['0x' + 'a0'.padStart(40, '0'), '0x' + 'b0'.padStart(40, '0'), 500],
  )
  assert.equal(key, want)
})

test('loadReceipts indexes JSON-lines receipts by lower-case tx hash, with uint fields as bigints', () => {
  const dir = mkdtempSync(join(tmpdir(), 'receipts-'))
  const path = join(dir, 'r.jsonl')
  assert.equal(loadReceipts(path).size, 0, 'no file yet')
  const r = (h) => ({
    receipt: { txHash: h, chainId: '31337', acceptedAt: '1700000000', maxBlock: '12', maxPayout: '300', beneficiary: '0xb0' },
    sig: '0xsig',
  })
  writeFileSync(path, [r('0xAB'), r('0xcd')].map((x) => JSON.stringify(x)).join('\n') + '\n')
  const m = loadReceipts(path)
  assert.equal(m.size, 2)
  assert.equal(m.get('0xab').receipt.maxPayout, 300n)
  assert.equal(m.get('0xab').receipt.chainId, 31337n)
  assert.equal(m.get('0xab').sig, '0xsig')
})

test("a reverting claim or collect names the registry's custom error", async () => {
  const abi = [{ type: 'error', name: 'ClaimWindowOpen', inputs: [{ type: 'uint256', name: 'closesAt' }] }]
  const data = encodeErrorResult({ abi, errorName: 'ClaimWindowOpen', args: [123n] })
  const client = { simulateContract: async () => { throw new ContractFunctionRevertedError({ abi, data, functionName: 'collect' }) } }
  const s = createSubmitter({ client, wallet: { account: '0x' + '33'.repeat(20) }, registry: '0x' + 'e0'.repeat(20), abi, receipts: () => new Map() })
  await assert.rejects(s.collect({ victimTx: '0x' + '11'.repeat(32) }), /collect reverts ClaimWindowOpen\(123\)/)
})
