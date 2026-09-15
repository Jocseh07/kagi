import { useEffect, useSyncExternalStore } from 'react'

import {
  getLocalLibraryState,
  loadLocalLibrary,
  subscribeLocalLibrary,
} from './library'
import type { LocalLibraryState } from './library'

/**
 * The chosen folder's state, kept in a module store rather than React state:
 * the source reads the same handle outside the component tree, and both have
 * to agree about which folder is current.
 */
export function useLocalLibrary(): LocalLibraryState {
  const state = useSyncExternalStore(
    subscribeLocalLibrary,
    getLocalLibraryState,
    getLocalLibraryState,
  )

  useEffect(() => {
    void loadLocalLibrary()
  }, [])

  return state
}
