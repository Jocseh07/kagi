import { useCallback, useEffect, useRef, useState } from 'react'

import { useDatabaseReady } from '@/lib/db/provider'
import { getSetting, setSetting } from '@/lib/db/repositories'

import {
  chapterFiltersKey,
  defaultChapterFilters,
  parseChapterFilters,
} from './filter-state'
import type { ChapterFilterState } from './filter-state'

/**
 * Filter and sort choices, remembered per series in the `settings` table so
 * the list looks the same on the next visit. Without a database they still
 * work, they just do not outlive the page.
 *
 * Shared rather than owned by the series page: the reader scopes its chapter
 * navigation by the same stored group choice, and a second copy of this would
 * be a second answer to the question of which group a series is being read
 * from.
 */
export function useChapterFilters(
  sourceId: string,
  mangaUrl: string,
): {
  filters: ChapterFilterState
  setFilters(next: ChapterFilterState): void
  /**
   * Whether the saved choice has been read back, or the database is absent.
   * Until then `filters` is the default and must not be written over: the
   * series page derives a group from it, and persisting that guess before the
   * real choice arrives would replace the choice with the guess.
   */
  loaded: boolean
} {
  const ready = useDatabaseReady()
  const key = chapterFiltersKey(sourceId, mangaUrl)
  const [state, setState] = useState<ChapterFilterState>(defaultChapterFilters)
  const [loaded, setLoaded] = useState(false)
  // A slow read must not overwrite a choice the user made while it was in
  // flight.
  const edited = useRef(false)

  useEffect(() => {
    if (!ready) return
    let active = true
    void getSetting(key).then(
      (raw) => {
        if (!active) return
        setLoaded(true)
        if (edited.current || !raw) return
        setState(parseChapterFilters(raw))
      },
      () => {
        if (active) setLoaded(true)
      },
    )
    return () => {
      active = false
    }
  }, [ready, key])

  // A choice made before the database opened used to be dropped on the floor:
  // the write was skipped and nothing ever retried it, so the selection worked
  // for the session and was gone on the next visit. It is held here instead
  // and flushed as soon as there is somewhere to put it.
  const pending = useRef<ChapterFilterState | null>(null)

  const setFilters = useCallback(
    (next: ChapterFilterState) => {
      edited.current = true
      setState(next)
      if (ready) {
        void setSetting(key, JSON.stringify(next)).catch(() => undefined)
      } else {
        pending.current = next
      }
    },
    [ready, key],
  )

  useEffect(() => {
    if (!ready || !pending.current) return
    const next = pending.current
    pending.current = null
    void setSetting(key, JSON.stringify(next)).catch(() => undefined)
  }, [ready, key])

  return { filters: state, setFilters, loaded }
}
