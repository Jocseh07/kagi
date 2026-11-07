/**
 * Picking the source a series moves to.
 *
 * Mihon's migration screen is its global search with the current source taken
 * out, and that is exactly what this is: the same rails Browse uses, seeded
 * with the series' own title, with a card standing for a choice rather than a
 * link.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowLeftRight, CloudOff, Heart, Search } from 'lucide-react'

import { mangaSlug } from '@/components/manga-grid'
import { PageContainer } from '@/components/page-container'
import { MigrateDialog } from '@/components/migrate/migrate-dialog'
import type { MigrateChoice } from '@/components/migrate/migrate-dialog'
import { GlobalSearchResults } from '@/components/sources/global-search-results'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorPanel } from '@/components/ui/error-panel'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useDatabaseReady } from '@/lib/db/provider'
import { dbKeys } from '@/lib/db/query-keys'
import { getMangaByUrl } from '@/lib/db/repositories'
import { migrateSeries } from '@/lib/migrate/migrate-series'
import { mangaStubOf } from '@/lib/reader/chapter-queries'
import { useOnline } from '@/lib/offline/use-online'
import { useHideAdultSources } from '@/lib/sources/adult'
import { getSource, listSources } from '@/lib/sources/registry'
import { isAdultRated, kindOf } from '@/lib/sources/types'
import type { SManga, Source } from '@/lib/sources/types'
import type { Manga } from '@/lib/db/schema'
import { notify } from '@/lib/ui/toast'
import { useDebounced } from '@/lib/use-debounced'

interface MigrateSearch {
  q?: string
}

export const Route = createFileRoute('/migrate/$sourceId/$slug')({
  validateSearch: (search: Record<string, unknown>): MigrateSearch =>
    typeof search.q === 'string' && search.q.trim() ? { q: search.q } : {},
  component: MigratePicker,
  pendingComponent: MigratePending,
})

function MigratePicker() {
  const { sourceId, slug } = Route.useParams()
  const source = tryGetSource(sourceId)
  const ready = useDatabaseReady()

  // The stored row, not the source's copy: migration moves what this device
  // holds, and a series that is not held has nothing to move.
  const storedUrl = mangaStubOf(slug).url
  const stored = useQuery({
    queryKey: dbKeys.manga(sourceId, storedUrl),
    queryFn: () => getMangaByUrl(sourceId, storedUrl),
    enabled: ready,
    staleTime: 0,
  })

  if (!source) {
    return (
      <PageContainer>
        <ErrorPanel error={new Error(`Unknown source: ${sourceId}`)} />
      </PageContainer>
    )
  }

  if (stored.isPending) return <MigratePending />

  if (!stored.data) {
    return (
      <PageContainer>
        <EmptyState
          icon={Heart}
          title="This series is not in your library"
          description="Follow it first, then migrate it to another source."
          action={
            <Button asChild size="sm">
              <Link to="/manga/$sourceId/$slug" params={{ sourceId, slug }}>
                Back to series
              </Link>
            </Button>
          }
        />
      </PageContainer>
    )
  }

  return <MigrateView from={stored.data} fromSource={source} slug={slug} />
}

function MigrateView({
  from,
  fromSource,
  slug,
}: {
  from: Manga
  fromSource: Source
  slug: string
}) {
  const online = useOnline()
  const hideAdult = useHideAdultSources()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { q } = Route.useSearch()
  // The title is the question until the reader asks a different one, so the
  // screen arrives with its search already run.
  const query = q ?? from.title

  const [rawQuery, setRawQuery] = useState(query)
  const debouncedQuery = useDebounced(rawQuery, 400)
  const syncedQuery = useRef(query)

  useEffect(() => {
    if (debouncedQuery === syncedQuery.current) return
    syncedQuery.current = debouncedQuery
    void navigate({
      to: '/migrate/$sourceId/$slug',
      params: { sourceId: fromSource.id, slug },
      search: debouncedQuery.trim() ? { q: debouncedQuery } : {},
      replace: true,
    })
  }, [debouncedQuery, navigate, fromSource.id, slug])

  useEffect(() => {
    if (query === syncedQuery.current) return
    syncedQuery.current = query
    setRawQuery(query)
  }, [query])

  // Same kind only: a novel's resume point is a scroll position and a comic's
  // is a page index, so carrying one onto the other would be carrying a number
  // that means something else. The source being left is out for the obvious
  // reason, and local sources have nothing to search.
  const kind = kindOf(fromSource)
  const targets = useMemo(
    () =>
      listSources().filter(
        (candidate) =>
          candidate.id !== fromSource.id &&
          !candidate.isLocal &&
          kindOf(candidate) === kind &&
          (!hideAdult || !isAdultRated(candidate)),
      ),
    [fromSource.id, kind, hideAdult],
  )

  const [target, setTarget] = useState<{ source: Source; manga: SManga } | null>(
    null,
  )

  const migrate = useMutation({
    mutationFn: async (choice: MigrateChoice) => {
      const result = await migrateSeries({
        from,
        toSourceId: choice.toSource.id,
        toManga: choice.toManga,
        toChapters: choice.toChapters,
        options: choice.options,
      })
      return { choice, result }
    },
    onSuccess: async ({ choice, result }) => {
      await queryClient.invalidateQueries({ queryKey: dbKeys.library })
      await queryClient.invalidateQueries({ queryKey: dbKeys.storage })
      await queryClient.invalidateQueries({ queryKey: dbKeys.queue })

      notify.success(
        choice.options.removeOld
          ? `Moved to ${choice.toSource.name}`
          : `Copied to ${choice.toSource.name}`,
        {
          description: `${result.chaptersMatched} chapter${
            result.chaptersMatched === 1 ? '' : 's'
          } kept their place.`,
        },
      )

      setTarget(null)
      void navigate({
        to: '/manga/$sourceId/$slug',
        params: {
          sourceId: choice.toSource.id,
          slug: mangaSlug(choice.toManga),
        },
        replace: true,
      })
    },
    onError: (error) => notify.error('Could not migrate that series', error),
  })

  return (
    <PageContainer>
      <header className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon-sm">
          <Link
            to="/manga/$sourceId/$slug"
            params={{ sourceId: fromSource.id, slug }}
            aria-label="Back to series"
          >
            <ArrowLeft />
          </Link>
        </Button>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight">
            Migrate {from.title}
          </h1>
          <p className="truncate text-sm text-muted-foreground">
            Pick where it should live instead of {fromSource.name}.
          </p>
        </div>
      </header>

      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={rawQuery}
          onChange={(event) => setRawQuery(event.target.value)}
          placeholder="Search all sources"
          aria-label="Search all sources"
          className="pl-8"
        />
      </div>

      {!online ? (
        <EmptyState
          icon={CloudOff}
          title="Migrating needs a connection"
          description="The new source has to be searched before anything moves."
        />
      ) : targets.length === 0 ? (
        <EmptyState
          icon={ArrowLeftRight}
          title="Nowhere to migrate to"
          description={`No other ${kind === 'novel' ? 'novel' : 'comic'} source is installed.`}
        />
      ) : (
        <GlobalSearchResults
          sources={targets}
          query={query}
          onPick={(source, manga) => setTarget({ source, manga })}
        />
      )}

      <MigrateDialog
        from={from}
        fromSourceName={fromSource.name}
        target={target}
        open={Boolean(target)}
        onOpenChange={(next) => {
          if (!next) setTarget(null)
        }}
        busy={migrate.isPending}
        error={migrate.error}
        onConfirm={(choice) => migrate.mutate(choice)}
      />
    </PageContainer>
  )
}

function MigratePending() {
  return (
    <PageContainer>
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-9 w-full rounded-lg" />
    </PageContainer>
  )
}

function tryGetSource(id: string): Source | null {
  try {
    return getSource(id)
  } catch {
    return null
  }
}
