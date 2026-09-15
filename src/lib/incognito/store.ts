/**
 * Incognito: read without leaving a trace.
 *
 * While it is on, the reader records nothing — no history entry, no page
 * position, no automatic mark-read — so there is also nothing for sync to
 * push. Deliberate actions (marking a chapter read, editing the library,
 * downloading) are untouched: incognito pauses tracking, not editing.
 *
 * `sessionStorage` rather than `localStorage`, because a mode whose whole
 * point is leaving nothing behind should not outlive the tab. Storing it at
 * all — rather than keeping it in a module variable — is only so a reload or a
 * route-level full navigation does not silently drop back into recording.
 */

import { useCallback, useSyncExternalStore } from 'react'

const STORAGE_KEY = 'kagi:incognito'

type Listener = () => void

const listeners = new Set<Listener>()

function read(): boolean {
  try {
    return globalThis.sessionStorage?.getItem(STORAGE_KEY) === '1'
  } catch {
    // Storage refusal; treat as off, and keep the session in memory below.
    return false
  }
}

/**
 * Cached so `useSyncExternalStore` sees a stable snapshot, and so a browser
 * that refuses storage still gets a working toggle for the session.
 */
let snapshot = read()

export function isIncognito(): boolean {
  return snapshot
}

export function setIncognito(next: boolean): void {
  if (next === snapshot) return
  snapshot = next

  try {
    if (next) globalThis.sessionStorage?.setItem(STORAGE_KEY, '1')
    else globalThis.sessionStorage?.removeItem(STORAGE_KEY)
  } catch {
    // Only its persistence across a reload is lost.
  }

  for (const listener of listeners) listener()
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): boolean {
  return snapshot
}

/** Server render (the prerendered shell) never has a session to read. */
function getServerSnapshot(): boolean {
  return false
}

export function useIncognito(): [boolean, (next: boolean) => void] {
  const incognito = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const set = useCallback((next: boolean) => setIncognito(next), [])
  return [incognito, set]
}
