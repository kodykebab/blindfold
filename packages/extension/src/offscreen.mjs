// Offscreen document: tlock encryption and ciphertext checks for the service worker (it will host the WASM prover).
import { check, encrypt } from './tlock.mjs'

const OPS = {
  encrypt: (m) => encrypt(BigInt(m.round), m.payload, m.drand),
  check: (m) => check(m.ciphertext, BigInt(m.round), m.payload, m.drand),
}
chrome.runtime.onMessage.addListener((m, sender, respond) => {
  if (m?.target !== 'offscreen' || sender.id !== chrome.runtime.id || !OPS[m.op]) return false
  OPS[m.op](m).then((result) => respond({ ok: true, result }), (e) => respond({ ok: false, error: e.message }))
  return true
})
