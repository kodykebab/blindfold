// U5: the extension's batch clock (target round and deadlines) matches BatchAuction's schedule math.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { roundAt } from 'tlock-js'
import { currentBatch, DRAND, schedule } from '../src/core.mjs'
import { deadlines } from '../../client/flow.mjs'

const G = DRAND.genesis
const roundTime = (r) => G + (r - 1n) * 3n // BatchAuction.roundTime

test('U5 recorded vector: a 900 s batch closing 6 s before round 1000000 targets it (client admission e2e)', () => {
  const now = G + (1000000n - 3n) * 3n - 900n
  const s = { start: now - (now - G) % 3n, batchLength: 900n, revealLength: 24n, settleLength: 30n }
  assert.equal(currentBatch(s, now), 0n)
  const b = schedule(s, 0n)
  assert.equal(b.targetRound, 1000000n)
  assert.deepEqual([b.commitsClose, b.revealOpens, b.revealCloses, b.settleCloses], [s.start + 900n, s.start + 906n, s.start + 930n, s.start + 960n])
})

test('U5 every aligned schedule: key out exactly 6 s after commits close (FeesAndTiming testFuzz_R7)', () => {
  for (let i = 0; i < 2000; i++) {
    const s = { start: G + 3n * BigInt(Math.floor(Math.random() * 1e8)), batchLength: 3n * BigInt(1 + Math.floor(Math.random() * 1000)), revealLength: 24n, settleLength: 30n }
    const b = BigInt(Math.floor(Math.random() * 1e6))
    const x = schedule(s, b)
    assert.equal(x.commitsClose, s.start + (b + 1n) * s.batchLength)
    assert.equal(x.revealOpens - x.commitsClose, 6n)
    assert.equal(roundTime(x.targetRound), x.commitsClose + 6n)
    assert.equal(x.revealCloses, x.revealOpens + s.revealLength)
    assert.equal(x.settleCloses, x.revealCloses + s.settleLength)
    // drand's own round clock (tlock-js) agrees: two rounds after the round current at commitsClose
    assert.equal(BigInt(roundAt(Number(x.commitsClose) * 1000, { genesis_time: Number(G), period: 3 })) + 2n, x.targetRound)
    // currentBatch flips exactly at commitsClose
    assert.equal(currentBatch(s, x.commitsClose - 1n), b)
    assert.equal(currentBatch(s, x.commitsClose), b + 1n)
  }
})

test('U5 deadlines feed the client deadline text in order', () => {
  const s = { start: G + 3n, batchLength: 30n, revealLength: 24n, settleLength: 30n }
  const d = deadlines(schedule(s, 5n), true)
  assert.deepEqual(d.map((x) => x.at), [G + 183n, G + 189n, G + 213n, G + 243n])
  assert.match(d[2].what, /released/)
})
