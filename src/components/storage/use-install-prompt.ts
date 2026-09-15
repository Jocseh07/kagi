import { useCallback, useState, useSyncExternalStore } from 'react'

import {
  canInstall,
  showInstallPrompt,
  subscribeInstallPrompt,
} from '@/lib/pwa/install-prompt'

/**
 * @param onInstalled Run after a successful install. Persistence is granted to
 * installed sites, so the caller uses this to ask for it again immediately
 * rather than leaving the user to press Request a second time.
 */
export function useInstallPrompt(onInstalled?: () => void) {
  const available = useSyncExternalStore(subscribeInstallPrompt, canInstall, () => false)
  const [installing, setInstalling] = useState(false)

  const install = useCallback(async () => {
    setInstalling(true)
    try {
      if ((await showInstallPrompt()) === 'accepted') onInstalled?.()
    } finally {
      setInstalling(false)
    }
  }, [onInstalled])

  return { available, installing, install }
}
