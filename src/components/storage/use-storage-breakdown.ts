import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { dbKeys } from '@/lib/db/query-keys'
import { unsaveAllChapters } from '@/lib/offline/save-chapter'
import { readStorageBreakdown } from '@/lib/storage/breakdown'
import type { StorageBucketId } from '@/lib/storage/breakdown'
import { clearAppShell, clearOtherData, eraseLibrary } from '@/lib/storage/clear'

/**
 * Reads the breakdown and clears any one bucket of it.
 *
 * One mutation rather than four, so the panel can disable every row while any
 * of them is running — these all touch the same origin storage, and a second
 * clear starting mid-flight would report against a figure already moving.
 */
export function useStorageBreakdown() {
  const queryClient = useQueryClient()

  const breakdown = useQuery({
    queryKey: dbKeys.storageBreakdown,
    queryFn: readStorageBreakdown,
    staleTime: 30_000,
  })

  const clear = useMutation({
    mutationFn: async (bucket: StorageBucketId): Promise<void> => {
      switch (bucket) {
        case 'saved-chapters':
          return await unsaveAllChapters()
        case 'library':
          return await eraseLibrary()
        case 'app-shell':
          return await clearAppShell()
        case 'other':
          return await clearOtherData()
      }
    },
    onSettled: async (_result, _error, bucket) => {
      // Erasing the library invalidates every database-backed read there is,
      // not only the ones that mention storage.
      if (bucket === 'library') {
        await queryClient.invalidateQueries()
        return
      }
      if (bucket === 'saved-chapters') {
        void queryClient.invalidateQueries({ queryKey: dbKeys.savedChapters })
        void queryClient.invalidateQueries({ queryKey: ['db', 'saved-chapter-ids'] })
        void queryClient.invalidateQueries({ queryKey: ['db', 'chapter-saved'] })
      }
      await queryClient.invalidateQueries({ queryKey: dbKeys.storage })
    },
  })

  return {
    total: breakdown.data?.total ?? null,
    buckets: breakdown.data?.buckets ?? [],
    loading: breakdown.isPending,
    /** The bucket being cleared right now, so its row can say so. */
    clearing: clear.isPending ? clear.variables : null,
    error: clear.error,
    clear: (bucket: StorageBucketId) => clear.mutate(bucket),
  }
}
