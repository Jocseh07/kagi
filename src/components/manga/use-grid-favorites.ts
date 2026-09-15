/**
 * Library membership for a whole grid of covers.
 *
 * The detail page's `useLibraryEntry` asks the database about one series; a
 * browse grid shows dozens at once, so this reads the source's favourited urls
 * in one query and answers from the set. Writes go through the same two steps
 * the detail page uses — record the series, then flip the flag — minus the
 * chapter seeding, because a grid has never fetched a chapter list.
 */
import { useCallback, useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useDatabaseReady } from '@/lib/db/provider'
import { dbKeys } from '@/lib/db/query-keys'
import { listFavoriteUrls, setFavorite, upsertManga } from '@/lib/db/repositories'
import { notify } from '@/lib/ui/toast'
import type { SManga } from '@/lib/sources/types'

export interface GridFavorites {
  /** False until the database has answered, so cards can stay disabled. */
  ready: boolean
  isFavorite(url: string): boolean
  /** True while this series' own write is in flight. */
  isBusy(url: string): boolean
  toggle(manga: SManga, next: boolean): void
}

export function useGridFavorites(sourceId: string): GridFavorites {
  const ready = useDatabaseReady()
  const queryClient = useQueryClient()

  // Under the `library` prefix, so every existing favourite write — the detail
  // page's heart, the library's bulk remove — already refreshes this.
  const favorites = useQuery({
    queryKey: [...dbKeys.library, 'urls', sourceId],
    queryFn: () => listFavoriteUrls(sourceId),
    enabled: ready,
    staleTime: 0,
  })

  const urls = favorites.data
  const favoriteUrls = useMemo(() => new Set(urls ?? []), [urls])

  const toggle = useMutation({
    mutationFn: async ({ manga, next }: { manga: SManga; next: boolean }) => {
      const row = await upsertManga(sourceId, manga)
      await setFavorite(row.id, next)
      return { manga, next }
    },
    onSuccess: ({ manga, next }) => {
      notify.success(next ? 'Added to library' : 'Removed from library', {
        id: `library:${sourceId}:${manga.url}`,
      })
      void queryClient.invalidateQueries({ queryKey: dbKeys.library })
      void queryClient.invalidateQueries({
        queryKey: dbKeys.manga(sourceId, manga.url),
      })
    },
    onError: (error, { next }) => {
      notify.error(
        next ? 'Could not add to library' : 'Could not remove from library',
        error,
      )
    },
  })

  const mutate = toggle.mutate
  // Per series rather than one flag for the grid: a write on one card must not
  // disable every other heart on screen.
  const pendingUrl = toggle.isPending ? toggle.variables.manga.url : null

  return {
    ready: ready && urls !== undefined,
    isFavorite: useCallback(
      (url: string) => favoriteUrls.has(url),
      [favoriteUrls],
    ),
    isBusy: useCallback((url: string) => url === pendingUrl, [pendingUrl]),
    toggle: useCallback(
      (manga: SManga, next: boolean) => mutate({ manga, next }),
      [mutate],
    ),
  }
}
