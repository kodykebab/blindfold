// A chrome.runtime.Port stand-in: emit() delivers a message from the other side, drop() disconnects from it.
export function fakePort({ name = 'blindfold-bridge', origin = 'http://localhost:4317' } = {}) {
  const on = { message: [], disconnect: [] }
  return {
    name, sender: { origin }, posted: [], disconnected: false,
    onMessage: { addListener: (f) => on.message.push(f) },
    onDisconnect: { addListener: (f) => on.disconnect.push(f) },
    postMessage(m) { this.posted.push(structuredClone(m)) },
    disconnect() { this.disconnected = true },
    emit(m) { for (const f of on.message) f(structuredClone(m)) },
    drop() { for (const f of on.disconnect) f() },
  }
}
