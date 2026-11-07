import { useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'

import { APP_RELEASE_PATH, parseAppRelease } from '@/lib/app-release'
import type { AppRelease } from '@/lib/app-release'
import { useOnline } from '@/lib/offline/use-online'
import { isAndroid } from '@/lib/pwa/android'
import { useStandalone } from '@/lib/pwa/installed'
import { isIos } from '@/lib/pwa/ios'
import { apiUrl } from '@/lib/sources/app-origin'

const RELEASE_KEY = ['app-release'] as const

function subscribeNever(): () => void {
  return () => {}
}

export type DeviceKind = 'android' | 'ios' | 'other'

function deviceKind(): DeviceKind {
  if (isIos()) return 'ios'
  return isAndroid() ? 'android' : 'other'
}

export function useDeviceKind(): DeviceKind {
  return useSyncExternalStore(subscribeNever, deviceKind, () => 'other')
}

/** `null` when nothing has been published yet. */
async function fetchAppRelease(): Promise<AppRelease | null> {
  const response = await fetch(apiUrl(APP_RELEASE_PATH))
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Release request failed: ${response.status}`)
  const release = parseAppRelease(await response.json())
  if (!release) throw new Error('The release response was not valid.')
  return release
}

export function useAppRelease(enabled: boolean) {
  return useQuery({
    queryKey: RELEASE_KEY,
    queryFn: fetchAppRelease,
    enabled,
    staleTime: 5 * 60_000,
    retry: 1,
  })
}

/**
 * The release to offer in the Home strip: an Android browser, online, not
 * already running the installed web app, with a build published.
 */
export function useAndroidOffer(): AppRelease | null {
  const android = useDeviceKind() === 'android'
  const standalone = useStandalone()
  const online = useOnline()
  const release = useAppRelease(android && !standalone)
  return android && !standalone && online ? (release.data ?? null) : null
}
