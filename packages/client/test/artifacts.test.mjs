import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { artifactPath } from '../lib.mjs'

test('clean compiler/profile artifacts prefer 0.8.26 default over other builds and stale output', () => {
  const root = mkdtempSync(join(tmpdir(), 'blindfold-profiles-'))
  const dir = join(root, 'MockERC20.sol')
  mkdirSync(dir)
  try {
    for (const variant of ['0.8.26.default', '0.8.30.default', '0.8.30.swapvm']) {
      writeFileSync(join(dir, `MockERC20.${variant}.json`), '{}')
    }
    const expected = join(dir, 'MockERC20.0.8.26.default.json')
    assert.equal(artifactPath(root, 'MockERC20'), expected)
    writeFileSync(join(dir, 'MockERC20.json'), '{}')
    assert.equal(artifactPath(root, 'MockERC20'), expected)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('unknown compiler profiles remain ambiguous instead of choosing arbitrary bytecode', () => {
  const root = mkdtempSync(join(tmpdir(), 'blindfold-profiles-'))
  const dir = join(root, 'Example.sol')
  mkdirSync(dir)
  try {
    writeFileSync(join(dir, 'Example.0.8.30.default.json'), '{}')
    writeFileSync(join(dir, 'Example.0.8.30.swapvm.json'), '{}')
    assert.throws(() => artifactPath(root, 'Example'), /select an explicit artifact/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
