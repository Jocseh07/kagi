/**
 * Whether the install banner has been waved away.
 *
 * `localStorage`, not `sessionStorage`: someone who does not want the app
 * installed should not be asked again next time they open it. Settings keeps a
 * permanent install row, so dismissing here closes a prompt, not the door.
 */

import { useCallback, useSyncExternalStore } from 'react'

const STORAGE_KEY = 'kagi:install-dismissed'

type Listener = () => void

const listeners = new Set<Listener>()

function read(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === '1'
  } catch {
    // Storage refusal; treat as not dismissed, and keep it in memory below.
    return false
  }
}

let snapshot = read()

export function dismissInstallPrompt(): void {
  if (snapshot) return
  snapshot = true

  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, '1')
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

/** The prerendered shell has no storage to read. */
function getServerSnapshot(): boolean {
  return false
}

export function useInstallDismissed(): [boolean, () => void] {
  const dismissed = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const dismiss = useCallback(() => dismissInstallPrompt(), [])
  return [dismissed, dismiss]
}
