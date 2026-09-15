/**
 * A series' library membership, and the one prompt that offers it.
 *
 * Both the Heart button and the "you just did something to a series you do not
 * follow" nudge write through here, so there is a single definition of what
 * adding means — the row, its chapters, then the favourite flag, in that order
 * because the library counts chapters and would otherwise show a fresh entry
 * as empty.
 */
import { useCallback, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useDatabase } from '@/lib/db/provider'
import { dbKeys } from '@/lib/db/query-keys'
import {
  getMangaByUrl,
  setFavorite,
  upsertChapters,
  upsertManga,
} from '@/lib/db/repositories'
import { notify } from '@/lib/ui/toast'
import type { SChapter, SManga } from '@/lib/sources/types'

export interface LibraryEntryState {
  /** False until the database has answered, so callers can stay disabled. */
  ready: boolean
  favorite: boolean
  busy: boolean
  setFavorite(next: boolean): void
  /**
   * Asks, once per visit, whether a series that is not followed should be.
   * A no-op for a series already in the library.
   */
  promptIfMissing(): void
}

export function useLibraryEntry(
  sourceId: string,
  manga: SManga,
  chapters: readonly SChapter[],
): LibraryEntryState {
  const { status } = useDatabase()
  const ready = status === 'ready'
  const queryClient = useQueryClient()

  const saved = useQuery({
    queryKey: dbKeys.manga(sourceId, manga.url),
    queryFn: () => getMangaByUrl(sourceId, manga.url),
    enabled: ready,
    staleTime: 0,
  })

  const favorite = saved.data?.favorite ?? false

  const toggle = useMutation({
    mutationFn: async (next: boolean) => {
      const row = await upsertManga(sourceId, manga)
      if (next && chapters.length > 0) await upsertChapters(row.id, chapters)
      await setFavorite(row.id, next)
      return next
    },
    onSuccess: (next) => {
      notify.success(next ? 'Added to library' : 'Removed from library', {
        id: `library:${sourceId}:${manga.url}`,
      })
      void queryClient.invalidateQueries({
        queryKey: dbKeys.manga(sourceId, manga.url),
      })
      void queryClient.invalidateQueries({ queryKey: dbKeys.library })
    },
    onError: (error, next) => {
      notify.error(
        next ? 'Could not add to library' : 'Could not remove from library',
        error,
      )
    },
  })

  const mutate = toggle.mutate

  /**
   * Once per visit, whatever the user does next. Downloading three chapters in
   * a row is one decision, not three, and asking three times about it is how a
   * helpful nudge turns into nagging.
   */
  const asked = useRef(false)

  const promptIfMissing = useCallback(() => {
    if (!ready || favorite || asked.current) return
    asked.current = true
    notify.ask(`Add ${manga.title} to your library?`, {
      id: `library-prompt:${sourceId}:${manga.url}`,
      description: 'Following it keeps new chapters arriving in Updates.',
      action: { label: 'Add', onClick: () => mutate(true) },
    })
  }, [ready, favorite, manga.title, sourceId, manga.url, mutate])

  return {
    ready,
    favorite,
    busy: toggle.isPending || saved.isPending,
    setFavorite: mutate,
    promptIfMissing,
  }
}
