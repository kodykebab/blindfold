// Only the opaque local job ID persists in the browser; private order state stays with the CLI.
export function createJobStore(storage) {
  const key = 'blindfold.localJob'
  return {
    get() { try { return storage?.getItem(key) ?? null } catch { return null } },
    set(id) { try { if (id) storage?.setItem(key, id); else storage?.removeItem(key) } catch {} },
  }
}

export function createBackupReminder(storage) {
  const key = 'blindfold.backupReminder'
  return {
    get() { try { return storage?.getItem(key) === '1' } catch { return false } },
    set(show) { try { if (show) storage?.setItem(key, '1'); else storage?.removeItem(key) } catch {} },
  }
}
