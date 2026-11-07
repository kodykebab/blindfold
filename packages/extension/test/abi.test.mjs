// The test ABI slice (mock.mjs) must match the contracts the build ships; skipped until `forge build` has run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { toFunctionSignature, toEventSignature } from 'viem'
import { abi } from './mock.mjs'
import { artifactPath } from '../../solver/artifacts.mjs'

const out = process.env.CONTRACTS_OUT || new URL('../../../contracts/out/', import.meta.url).pathname
const artifact = (name) => JSON.parse(readFileSync(artifactPath(out, name), 'utf8')).abi

const sig = (x) => (x.type === 'event' ? toEventSignature(x) : toFunctionSignature(x))

test('test ABI slice matches contracts/out', { skip: !existsSync(`${out}/AdmittedSettlement.sol`) && 'contracts/out not built' }, () => {
  for (const [name, part] of [['AdmittedSettlement', 'settlement'], ['BlindfoldVault', 'vault'], ['MockERC20', 'erc20']]) {
    const real = new Set(artifact(name).filter((x) => x.type !== 'constructor' && x.type !== 'error').map(sig))
    for (const x of abi[part]) assert.ok(real.has(sig(x)), `${name} has no ${sig(x)}`)
  }
})
