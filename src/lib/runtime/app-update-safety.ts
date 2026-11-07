let blocked = false
const listeners = new Set<() => void>()
export const appUpdateBlocked = () => blocked
export function setAppUpdateBlocked(value: boolean) {
  blocked = value
  for (const listener of listeners) listener()
}
export function subscribeAppUpdate(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
