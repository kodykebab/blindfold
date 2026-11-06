import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { artifactPath } from '../artifacts.mjs'

test('fresh multi-compiler Foundry artifacts resolve without a stale unversioned file', () => {
  const root = mkdtempSync(join(tmpdir(), 'blindfold-artifact-test-'))
  const dir = join(root, 'BlindfoldSettlement.sol')
  mkdirSync(dir)
  try {
    writeFileSync(join(dir, 'BlindfoldSettlement.0.8.37.json'), '{}')
    writeFileSync(join(dir, 'BlindfoldSettlement.0.8.26.json'), '{}')
    assert.equal(artifactPath(root, 'BlindfoldSettlement'), join(dir, 'BlindfoldSettlement.0.8.26.json'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
