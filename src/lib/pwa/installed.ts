/**
 * Whether this is the installed app rather than a browser tab.
 *
 * Two signals, because no single one covers every platform: Chromium and
 * modern Safari report `display-mode: standalone`, while older iOS Safari only
 * sets the non-standard `navigator.standalone`. The media query is subscribed
 * to rather than read once, so installing during a session hides the prompt
 * without a reload.
 */

import { useSyncExternalStore } from 'react'

const QUERY = '(display-mode: standalone)'

type Listener = () => void

const listeners = new Set<Listener>()

function read(): boolean {
  if (typeof window === 'undefined') return false

  if (window.matchMedia?.(QUERY).matches) return true

  // iOS Safari's own flag, absent from the standard Navigator type.
  return (navigator as Navigator & { standalone?: boolean }).standalone === true
}

let snapshot = read()

if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  window.matchMedia(QUERY).addEventListener('change', () => {
    const next = read()
    if (next === snapshot) return
    snapshot = next
    for (const listener of listeners) listener()
  })
}

export function isStandalone(): boolean {
  return snapshot
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

/** The prerendered shell has no display mode to read. */
function getServerSnapshot(): boolean {
  return false
}

export function useStandalone(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
