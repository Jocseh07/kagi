/**
 * "Show 18+ sources", one switch in Settings → Browse that the Browse source
 * list reads.
 *
 * Stored as hiding rather than showing so it obeys `getFlag`'s rule that an
 * unwritten key is off: absent means nothing is hidden, which is the state the
 * app has always been in. A source hidden here is only missing from Browse —
 * anything already in the library still opens, because this is a filter, not
 * a lock.
 */

import { useQuery } from '@tanstack/react-query'

import { useDatabaseReady } from '@/lib/db/provider'
import { getFlag } from '@/lib/db/repositories'

export const SETTING_HIDE_ADULT_SOURCES = 'browse.hideAdultSources'

export const hideAdultSourcesQueryKey = [
  'db',
  'setting',
  SETTING_HIDE_ADULT_SOURCES,
] as const

/**
 * Showing until the database says otherwise, like every other display flag:
 * the list that renders before the read lands is the one the app has always
 * had, so no row is pulled out from under a press. The cost is that someone
 * who hides these sees them for the moment the read takes on a cold open.
 */
export function useHideAdultSources(): boolean {
  const ready = useDatabaseReady()

  const flag = useQuery({
    queryKey: hideAdultSourcesQueryKey,
    queryFn: () => getFlag(SETTING_HIDE_ADULT_SOURCES),
    enabled: ready,
    staleTime: Infinity,
  })

  return flag.data ?? false
}
