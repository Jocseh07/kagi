import { useSyncExternalStore } from 'react'

import { useInstallPrompt } from '@/components/storage/use-install-prompt'
import { isIos } from '@/lib/pwa/ios'
import { useStandalone } from '@/lib/pwa/installed'

export type InstallOffer =
  /** Chromium handed over an install event; the app can open the real dialog. */
  | 'prompt'
  /** iOS, where the steps have to be spelled out instead. */
  | 'instructions'
  /** Already installed, or a browser that cannot. */
  | 'none'

/** The user agent does not change mid-session; nothing will ever fire. */
function subscribeNever(): () => void {
  return () => {}
}

/**
 * Which install path this browser has, if any.
 *
 * Shared so the banner and the settings row never disagree about whether the
 * app can be installed. The user agent never changes, so it is read through a
 * store that never notifies: the point is only its server snapshot, which
 * keeps the prerendered shell from disagreeing with the browser at hydration.
 *
 * @param onInstalled Run after a successful install, for the caller that wants
 * to act on it: persistence is granted to installed sites, so Settings asks
 * for it again straight away.
 */
export function useInstallOffer(onInstalled?: () => void) {
  const standalone = useStandalone()
  const prompt = useInstallPrompt(onInstalled)
  const ios = useSyncExternalStore(subscribeNever, isIos, () => false)

  const offer: InstallOffer = standalone
    ? 'none'
    : prompt.available
      ? 'prompt'
      : ios
        ? 'instructions'
        : 'none'

  return { offer, standalone, install: prompt.install, installing: prompt.installing }
}
