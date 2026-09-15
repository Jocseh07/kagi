/**
 * The profile, read synchronously and shared app-wide.
 *
 * A subscription rather than a plain `useState` because two places render the
 * same profile at once — the header and the Settings panel — and saving in one
 * has to move the other on the same frame. `storage` events cover a second tab;
 * they do not fire in the tab that wrote, hence the local listener set.
 */

import { useCallback, useSyncExternalStore } from 'react'

import {
  PROFILE_KEY,
  clearProfile,
  readProfile,
  writeProfile,
  type Profile,
} from '@/lib/profile/store'

type Listener = () => void

const listeners = new Set<Listener>()

/**
 * Cached because `useSyncExternalStore` compares snapshots by identity, and
 * parsing the JSON afresh on every render would return a new object each time
 * and loop forever.
 */
let snapshot: Profile | null = readProfile()

function emit(): void {
  snapshot = readProfile()
  for (const listener of listeners) listener()
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)

  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === PROFILE_KEY) emit()
  }
  globalThis.addEventListener?.('storage', onStorage)

  return () => {
    listeners.delete(listener)
    globalThis.removeEventListener?.('storage', onStorage)
  }
}

function getSnapshot(): Profile | null {
  return snapshot
}

export type ProfileState = {
  profile: Profile | null
  save: (profile: Omit<Profile, 'createdAt'>) => void
  clear: () => void
}

export function useProfile(): ProfileState {
  const profile = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const save = useCallback((next: Omit<Profile, 'createdAt'>) => {
    // Kept from the existing profile so editing your name does not reset the
    // date you started.
    writeProfile({ ...next, createdAt: readProfile()?.createdAt ?? Date.now() })
    emit()
  }, [])

  const clear = useCallback(() => {
    clearProfile()
    emit()
  }, [])

  return { profile, save, clear }
}
