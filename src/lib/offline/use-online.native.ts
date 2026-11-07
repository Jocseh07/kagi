import { useSyncExternalStore } from 'react'
import { addNetworkStateListener, getNetworkStateAsync } from 'expo-network'
import type { NetworkState } from 'expo-network'

type Listener = () => void

const listeners = new Set<Listener>()

// Unknown counts as on, like the web's prerender: false is the only reliable answer.
let online = true

function apply(state: NetworkState): void {
  const next = state.isConnected !== false && state.isInternetReachable !== false
  if (next === online) return
  online = next
  for (const listener of listeners) listener()
}

void getNetworkStateAsync().then(apply, () => undefined)
addNetworkStateListener(apply)

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function read(): boolean {
  return online
}

export function isOnline(): boolean {
  return online
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, read, read)
}
