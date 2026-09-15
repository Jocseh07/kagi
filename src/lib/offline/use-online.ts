/**
 * Whether the browser has a network connection.
 *
 * `navigator.onLine` is a floor, not a promise: false is reliable — there is
 * no interface to reach anything — while true only means an interface exists,
 * and says nothing about whether a source will answer. Everything here treats
 * it that way, reporting offline as a fact and leaving the online case to fail
 * on its own terms.
 */

import { useSyncExternalStore } from 'react'

type Listener = () => void

/** Reads the live value; `undefined` navigator (the prerender) counts as on. */
function read(): boolean {
  if (typeof navigator === 'undefined') return true
  return navigator.onLine
}

function subscribe(listener: Listener): () => void {
  globalThis.addEventListener('online', listener)
  globalThis.addEventListener('offline', listener)
  return () => {
    globalThis.removeEventListener('online', listener)
    globalThis.removeEventListener('offline', listener)
  }
}

/**
 * Read outside React, for route guards and error classification. Unlike the
 * hook, this does not re-render anything when the connection changes.
 */
export function isOnline(): boolean {
  return read()
}

/** The prerendered shell has no connection state to report. */
function getServerSnapshot(): boolean {
  return true
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, read, getServerSnapshot)
}
