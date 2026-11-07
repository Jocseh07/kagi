export function hasJournalStorage(): boolean {
  return typeof indexedDB !== 'undefined'
}
