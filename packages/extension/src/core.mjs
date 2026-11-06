// Browser-safe ports of the Node-only parts of packages/client (lib.mjs, state.mjs): same behaviour, no fs/crypto/env.
// The pure client modules (flow.mjs, admission-state.mjs) are imported as they are.
import { bytesToHex, decodeAbiParameters, encodeAbiParameters, hexToBytes, keccak256 } from 'viem'
import { validateFunding } from '../../client/admission-state.mjs'

export const ORDER = {
  type: 'tuple',
  components: [
    { name: 'owner', type: 'address' },
    { name: 'zeroForOne', type: 'bool' },
    { name: 'amountIn', type: 'uint128' },
    { name: 'minAmountOut', type: 'uint128' },
  ],
}

/** Same as BatchAuction.orderHash: keccak256(abi.encode(chainid, settlement, batchId, order, salt)). */
export function orderHash(chainId, settlement, batchId, order, salt) {
  return keccak256(encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'address' }, { type: 'uint64' }, ORDER, { type: 'bytes32' }],
    [BigInt(chainId), settlement, BigInt(batchId), order, salt],
  ))
}

export const newSalt = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
/** The 160-byte tlock plaintext: abi.encode(order, salt). */
export const encodePayload = (order, salt) => encodeAbiParameters([ORDER, { type: 'bytes32' }], [order, salt])
export function decodePayload(hex) {
  const [order, salt] = decodeAbiParameters([ORDER, { type: 'bytes32' }], hex)
  return { order, salt }
}

// The chain carries raw AGE bytes; tlock-js speaks the armored form (client lib.mjs armor/dearmor).
const ARMOR = ['-----BEGIN AGE ENCRYPTED FILE-----', '-----END AGE ENCRYPTED FILE-----']
export const armor = (hex) =>
  `${ARMOR[0]}\n${btoa(String.fromCharCode(...hexToBytes(hex))).match(/.{1,64}/g).join('\n')}\n${ARMOR[1]}\n`
export const dearmor = (text) =>
  bytesToHex(Uint8Array.from(atob(text.replace(ARMOR[0], '').replace(ARMOR[1], '').replace(/\s+/g, '')), (c) => c.charCodeAt(0)))

// ---- schedule (BatchAuction): the batch clock, computed from the settlement's immutables

export const DRAND = { genesis: 1692803367n, period: 3n, margin: 2n, chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971' }

/** s: {start, batchLength, revealLength, settleLength} as bigints. Mirrors currentBatch/commitsClose/targetRound/... */
export function schedule(s, batchId) {
  const commitsClose = s.start + (batchId + 1n) * s.batchLength
  const targetRound = (commitsClose - DRAND.genesis) / DRAND.period + 1n + DRAND.margin
  const revealOpens = DRAND.genesis + (targetRound - 1n) * DRAND.period
  const revealCloses = revealOpens + s.revealLength
  return { batchId, commitsClose, targetRound, revealOpens, revealCloses, settleCloses: revealCloses + s.settleLength }
}
export const currentBatch = (s, now) => (now - s.start) / s.batchLength

// ---- private state (client state.mjs): same JSON shape, so exports move between the CLI and the extension

export const replacer = (_, v) => (typeof v === 'bigint' ? `${v}n` : v)
export const reviver = (_, v) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)
export const stateId = (dep, owner) => `${dep.chainId}-${dep.settlement}-${owner}`.toLowerCase()
export const emptyState = (dep, owner) => ({ chainId: dep.chainId, settlement: dep.settlement, owner, commitments: [] })

/** Insert or update by hash (client saveCommitment / importState). Local entries the update lacks are kept. */
export function mergeCommitments(state, entries) {
  for (const c of entries) {
    const i = state.commitments.findIndex((x) => x.hash === c.hash)
    if (i === -1) state.commitments.push(c)
    else state.commitments[i] = { ...state.commitments[i], ...c }
  }
  return state
}

/** client validateState: same chain/settlement/owner, every order hashes to its hash, every id matches the chain. */
export function validateState(state, { dep, owner, chainHashes }) {
  const problems = []
  if (state.chainId !== dep.chainId || state.settlement?.toLowerCase() !== dep.settlement.toLowerCase()) problems.push('state is for another chain or settlement')
  if (state.owner?.toLowerCase() !== owner.toLowerCase()) problems.push(`state belongs to ${state.owner}`)
  if (state.admission) {
    try { validateFunding(dep, owner, state.admission); if (state.admission.pending) validateFunding(dep, owner, state.admission.pending.next) }
    catch (e) { problems.push(e.message) }
  }
  for (const c of state.commitments ?? []) {
    if (c.order?.owner?.toLowerCase() !== owner.toLowerCase()) problems.push(`commitment ${c.hash}: order owner is not ${owner}`)
    else if (orderHash(dep.chainId, dep.settlement, c.batchId, c.order, c.salt) !== c.hash) problems.push(`commitment ${c.hash}: order and salt do not hash to it`)
    if (c.id != null && chainHashes.get(c.id) !== c.hash) problems.push(`commitment #${c.id}: chain has ${chainHashes.get(c.id) ?? 'nothing'} (stale or foreign state)`)
  }
  return problems
}
