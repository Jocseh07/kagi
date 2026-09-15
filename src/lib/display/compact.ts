/**
 * "Compact list view", one switch in Settings → Appearance that both the
 * library and a series' chapter list read.
 *
 * A flag rather than a per-surface toggle: the reader is choosing a density
 * for the app, not configuring two screens that happen to look alike.
 */

import { useQuery } from '@tanstack/react-query'

import { useDatabaseReady } from '@/lib/db/provider'
import { getFlag } from '@/lib/db/repositories'

export const SETTING_COMPACT_LIST = 'display.compactList'

export const compactListQueryKey = ['db', 'setting', SETTING_COMPACT_LIST] as const

/**
 * Off until the database says otherwise: the layout that renders before the
 * read lands is the one the app has always had, so a slow open cannot flash
 * the denser one at someone who never asked for it.
 */
export function useCompactList(): boolean {
  const ready = useDatabaseReady()

  const flag = useQuery({
    queryKey: compactListQueryKey,
    queryFn: () => getFlag(SETTING_COMPACT_LIST),
    enabled: ready,
    staleTime: Infinity,
  })

  return flag.data ?? false
}
