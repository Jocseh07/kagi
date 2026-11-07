/**
 * Calls `listener` when another tab writes `key` to localStorage, or clears it.
 * The `storage` event only fires in other tabs; this tab notifies itself.
 */
export function onStorageChange(key: string, listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
