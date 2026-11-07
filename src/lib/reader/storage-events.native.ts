/** One app process, no other tabs: every write already notifies in-process listeners. */
export function onStorageChange(_key: string, _listener: () => void): () => void {
  return () => undefined
}
