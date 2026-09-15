import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { dbKeys } from '@/lib/db/query-keys'
import {
  estimate,
  isPersisted,
  permissionState,
  requestPersistence,
  supportsPersistence,
} from '@/lib/storage/persist'
import type { PersistPermission, StorageUsage } from '@/lib/storage/persist'

export interface StorageState {
  persisted: boolean
  usage: StorageUsage | null
}

/**
 * The outcome of a click. `denied` carries the permission state so the UI can
 * tell "unblock this in site settings" from "the browser is not convinced".
 */
export interface RequestOutcome {
  granted: boolean
  permission: PersistPermission
}

export async function readStorageState(): Promise<StorageState> {
  return { persisted: await isPersisted(), usage: await estimate() }
}

/**
 * Says what the click did.
 *
 * Deliberately does not suggest bookmarking or enabling notifications. Chromium
 * only counts a bookmark when the profile has five or fewer of them, so that
 * advice fails for almost everyone, and notifications are a permission a reader
 * has no use for. Installing is the one lever worth offering.
 */
export function describeOutcome(
  outcome: RequestOutcome,
  installAvailable: boolean,
): string {
  if (outcome.granted) {
    return 'Storage is now persistent. Your library will not be evicted.'
  }
  if (outcome.permission === 'denied') {
    return 'This browser has blocked persistent storage for this site. Allow it in the site permissions next to the address bar, then request again.'
  }
  if (installAvailable) {
    return 'The browser declined. Installing the app is the dependable way to change that: an installed site is granted persistence.'
  }
  return 'The browser declined. Chromium decides this silently and grants it once it treats the site as important, which comes with regular use — so try again later, and keep an exported backup until then.'
}

/**
 * Shared by every place that shows persistence, so a request made on one page
 * settles the state everywhere. The permission is read after the request
 * rather than before: a browser that blocks the prompt only says so once it
 * has been asked.
 */
export function useStoragePersistence() {
  const queryClient = useQueryClient()

  const storage = useQuery({
    queryKey: dbKeys.storage,
    queryFn: readStorageState,
    staleTime: 30_000,
  })

  const request = useMutation({
    mutationFn: async (): Promise<RequestOutcome> => {
      const outcome = await requestPersistence()
      if (outcome === 'granted') return { granted: true, permission: 'granted' }
      return { granted: false, permission: await permissionState() }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: dbKeys.storage }),
  })

  return {
    persisted: storage.data?.persisted ?? false,
    usage: storage.data?.usage ?? null,
    loading: storage.isPending,
    supported: supportsPersistence(),
    outcome: request.data ?? null,
    isPending: request.isPending,
    request: () => request.mutate(),
  }
}
