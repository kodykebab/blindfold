// Native-messaging client for the prover helper (D1; extension-team/INTERFACES.md, "Extension <-> prover helper").
// Request {id, cmd, ...args}; response {id, ok, result} or {id, ok: false, error: {code, message}}.
export const HOST = 'xyz.blindfold.prover'

/**
 * connect() returns a chrome.runtime.Port. One port is one helper process, which holds a preparation's witness between
 * prepare and online, so the caller keeps it open across both and close()s it after (an open port keeps the worker alive).
 */
export function helper(connect = () => chrome.runtime.connectNative(HOST), timeouts = {}) {
  const limits = { hello: 15_000, prepare: 12 * 60_000, online: 11 * 60_000, ...timeouts }
  let port = null
  const pending = new Map()
  let n = 0

  function open() {
    if (port) return port
    const p = (port = connect())
    p.onMessage.addListener((m) => {
      const x = pending.get(m?.id)
      if (!x) return
      pending.delete(m.id)
      clearTimeout(x.timer)
      if (m.ok) x.resolve(m.result)
      else x.reject(Object.assign(new Error(`prover helper: ${m.error?.message ?? 'failed'} (${m.error?.code})`), { code: m.error?.code }))
    })
    p.onDisconnect.addListener(() => {
      if (port !== p) return
      port = null
      const why = globalThis.chrome?.runtime?.lastError?.message ?? 'it exited'
      const err = new Error(`prover helper disconnected (${why}); install it with packages/prover-helper/install.sh`)
      for (const x of pending.values()) { clearTimeout(x.timer); x.reject(err) }
      pending.clear()
    })
    return p
  }

  function close(err = new Error('prover helper closed')) {
    const p = port
    port = null
    p?.disconnect()
    for (const x of pending.values()) { clearTimeout(x.timer); x.reject(err) }
    pending.clear()
  }

  return {
    call(cmd, args = {}) {
      const id = `${cmd}-${Date.now()}-${n++}`
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => close(Object.assign(new Error(`prover helper timed out during ${cmd}; check the native host installation`), { code: 'E_TIMEOUT' })), limits[cmd] ?? limits.online)
        pending.set(id, { resolve, reject, timer })
        try { open().postMessage({ ...args, id, cmd }) } catch (e) { close(e) }
      })
    },
    close,
  }
}
