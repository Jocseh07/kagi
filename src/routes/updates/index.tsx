import { useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import {
  EmptyUpdates,
  UpdateFeed,
  UpdateFeedSkeleton,
} from '@/components/updates/update-feed'
import { UpdateRunner } from '@/components/updates/update-runner'
import { useUpdateRuntime } from '@/components/updates/use-update-runtime'
import { PageContainer } from '@/components/page-container'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ErrorPanel } from '@/components/ui/error-panel'
import { listCategories } from '@/lib/db/categories'
import { countFavorites } from '@/lib/db/library'
import { useDatabase } from '@/lib/db/provider'
import { dbKeys } from '@/lib/db/query-keys'
import {
  countUnseenUpdates,
  groupByDay,
  listRecentChapters,
} from '@/lib/db/updates'
import {
  getLastRunAt,
  getLastSeenAt,
  isUpdateDue,
  loadUpdatePrefs,
  markUpdatesSeen,
  updateManager,
  updatePrefsQueryKey,
} from '@/lib/updates/update-manager'

export const Route = createFileRoute('/updates/')({
  component: UpdatesPage,
  pendingComponent: UpdatesPending,
})

const ALL_CATEGORIES = 'all'

const lastRunQueryKey = [...dbKeys.updates, 'last-run'] as const
// Deliberately outside the `updates` prefix: a run invalidates that whole
// key while it finds chapters, and this value must hold for the visit.
const lastSeenQueryKey = ['db', 'updates-last-seen'] as const

function UpdatesPage() {
  const { status, error } = useDatabase()
  const ready = status === 'ready'
  const runtime = useUpdateRuntime()
  const queryClient = useQueryClient()

  const prefs = useQuery({
    queryKey: updatePrefsQueryKey,
    queryFn: loadUpdatePrefs,
    enabled: ready,
    staleTime: 0,
  })

  const categories = useQuery({
    queryKey: dbKeys.categories,
    queryFn: listCategories,
    enabled: ready,
    staleTime: 0,
  })

  const favorites = useQuery({
    queryKey: [...dbKeys.library, 'count'],
    queryFn: countFavorites,
    enabled: ready,
    staleTime: 0,
  })

  const feed = useQuery({
    queryKey: dbKeys.updates,
    queryFn: () => listRecentChapters(),
    enabled: ready,
    staleTime: 0,
  })

  const lastRun = useQuery({
    queryKey: lastRunQueryKey,
    queryFn: getLastRunAt,
    // Refetched after a run, so the "last checked" line does not go stale.
    enabled: ready,
    staleTime: 0,
  })

  // Read once per visit: the marker is moved forward as soon as the page opens,
  // so the count has to be taken against the value from before that.
  const lastSeen = useQuery({
    queryKey: lastSeenQueryKey,
    queryFn: getLastSeenAt,
    enabled: ready,
    staleTime: Infinity,
  })

  const unseen = useQuery({
    queryKey: [...dbKeys.updatesUnseen, lastSeen.data ?? 0],
    queryFn: () => countUnseenUpdates(lastSeen.data ?? undefined),
    enabled: ready && lastSeen.isSuccess,
    staleTime: 0,
  })

  // Local until the user picks something, then it wins over the stored default
  // for the rest of the visit.
  const [scopeOverride, setScopeOverride] = useState<string | null>(null)
  const categoryId =
    scopeOverride === null
      ? (prefs.data?.categoryId ?? null)
      : scopeOverride === ALL_CATEGORIES
        ? null
        : scopeOverride

  // Two local queries, no source traffic: what the button would start.
  const preview = useQuery({
    queryKey: [...dbKeys.updates, 'preview', categoryId],
    queryFn: () => updateManager.previewUpdate({ categoryId }),
    enabled: ready,
    staleTime: 0,
  })

  useMarkSeen(ready && lastSeen.isSuccess)

  // Nothing starts on its own. A due check is flagged, and the user runs it.
  const due =
    prefs.isSuccess &&
    lastRun.isSuccess &&
    isUpdateDue(prefs.data.intervalHours, lastRun.data)

  const finishedAt = runtime.summary?.finishedAt
  useEffect(() => {
    if (!finishedAt) return
    void queryClient.invalidateQueries({ queryKey: lastRunQueryKey })
  }, [queryClient, finishedAt])

  const days = useMemo(() => groupByDay(feed.data ?? []), [feed.data])

  return (
    <PageContainer>
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Updates</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {unseen.data
            ? `${unseen.data} unread chapter${unseen.data === 1 ? '' : 's'} since your last visit.`
            : 'New chapters found in your favourites.'}
        </p>
      </header>

      <UpdateRunner
        runtime={runtime}
        disabled={!ready}
        unavailable={
          ready
            ? null
            : status === 'loading'
              ? 'Waiting for the library database…'
              : (error?.message ?? 'The library database is unavailable.')
        }
        lastRunAt={lastRun.data ?? null}
        preview={preview.data ?? null}
        due={due}
        scope={
          <Select
            value={categoryId ?? ALL_CATEGORIES}
            disabled={!ready || categories.isPending}
            onValueChange={setScopeOverride}
          >
            <SelectTrigger aria-label="Categories to check" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
              {(categories.data ?? []).map((category) => (
                <SelectItem key={category.id} value={category.id}>
                  {category.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
        onRun={() => void updateManager.runUpdate({ categoryId })}
        onCancel={() => updateManager.cancel()}
        onDismiss={() => updateManager.dismissSummary()}
        onRetry={(mangaIds) =>
          void updateManager.runUpdate({ categoryId, only: mangaIds })
        }
      />

      {status === 'error' ? (
        <ErrorPanel
          error={error ?? new Error('The library database is unavailable.')}
        />
      ) : feed.isError ? (
        <ErrorPanel error={feed.error} onRetry={() => void feed.refetch()} />
      ) : feed.isPending ? (
        <UpdateFeedSkeleton />
      ) : days.length === 0 ? (
        <EmptyUpdates hasFavorites={(favorites.data ?? 0) > 0} />
      ) : (
        <UpdateFeed days={days} />
      )}
    </PageContainer>
  )
}

/**
 * The route's shape while its chunk loads.
 *
 * Heading and subheading are the same constants the loaded page shows before
 * its counts arrive, so nothing rewrites itself when they do.
 */
function UpdatesPending() {
  return (
    <PageContainer>
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Updates</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          New chapters found in your favourites.
        </p>
      </header>
      <UpdateFeedSkeleton />
    </PageContainer>
  )
}

/** Moves the "new since your last visit" marker forward, once per visit. */
function useMarkSeen(enabled: boolean): void {
  const marked = useRef(false)

  useEffect(() => {
    if (!enabled || marked.current) return
    marked.current = true
    // A marker that will not persist is not a reason to break the page.
    void markUpdatesSeen().catch(() => undefined)
  }, [enabled])
}

