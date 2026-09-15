import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ArrowLeft, Loader2, Search } from 'lucide-react'

import { FilterDialog } from '@/components/filter-dialog'
import { ContentRatingBadge } from '@/components/sources/content-rating-badge'
import { MangaGrid, MangaGridSkeleton } from '@/components/manga-grid'
import { MangaListSkeleton } from '@/components/manga-list-row'
import { Skeleton } from '@/components/ui/skeleton'
import { PageContainer } from '@/components/page-container'
import { Button } from '@/components/ui/button'
import { ErrorPanel } from '@/components/ui/error-panel'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getSource } from '@/lib/sources/registry'
import {
  applyFilterDiff,
  encodeFilterDiff,
  findGenreFilterPath,
  parseFilterDiff,
} from '@/lib/sources/filter-url'
import type { FilterDiff } from '@/lib/sources/filter-url'
import { useCompactList } from '@/lib/display/compact'
import { useDebounced } from '@/lib/use-debounced'
import { hasCoverArt } from '@/lib/sources/types'
import type { FilterList, Source } from '@/lib/sources/types'

type Tab = 'popular' | 'latest' | 'search'

/**
 * What is on screen, held in the URL so Back undoes a filter rather than
 * leaving the page, and so a link reopens the same results.
 *
 * Every key is optional and omitted at its default, which keeps the plain
 * `/browse/$sourceId` links elsewhere in the app valid and the address bar
 * clean until something is actually chosen.
 */
interface BrowseSearch {
  tab?: Tab
  q?: string
  f?: FilterDiff
  /**
   * A genre to browse by, as a series page names it.
   *
   * A request rather than state: only this page knows the source's filter
   * list, so it resolves the name to the matching toggle and replaces itself
   * with the equivalent `f`. A series page cannot compute that itself without
   * fetching the source's filter data first.
   */
  genre?: string
}

export const Route = createFileRoute('/browse/$sourceId')({
  validateSearch: (search: Record<string, unknown>): BrowseSearch => {
    const next: BrowseSearch = {}

    if (search.tab === 'latest' || search.tab === 'search') next.tab = search.tab
    if (typeof search.q === 'string' && search.q.trim()) next.q = search.q

    const f = parseFilterDiff(search.f)
    if (f) next.f = f

    if (typeof search.genre === 'string' && search.genre.trim()) {
      next.genre = search.genre
    }

    return next
  },
  component: BrowseSource,
  pendingComponent: BrowseSourcePending,
})

/**
 * The route's shape while its chunk loads.
 *
 * The header is reserved rather than omitted: leave it out and the grid starts
 * at the top of the page, then gets shoved down by a header and a tab strip
 * the moment the route arrives — the exact jump a pending state exists to
 * prevent. The back arrow and the source name are known here (the registry is
 * a synchronous lookup), so they render for real; only the search field and
 * the tabs stand in as bars.
 */
function BrowseSourcePending() {
  const { sourceId } = Route.useParams()
  const source = tryGetSource(sourceId)

  return (
    <PageContainer>
      <header className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon-sm">
          <Link to="/browse" aria-label="Back to sources">
            <ArrowLeft />
          </Link>
        </Button>
        <div className="flex min-w-0 items-center gap-2">
          {source ? (
            <>
              <h1 className="truncate text-xl font-semibold tracking-tight">
                {source.name}
              </h1>
              <ContentRatingBadge rating={source.contentRating} />
            </>
          ) : (
            <Skeleton className="h-7 w-40" />
          )}
        </div>
      </header>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Skeleton className="h-9 flex-1 rounded-md" />
      </div>

      <div className="flex flex-col gap-2 md:gap-3 lg:gap-4">
        <Skeleton className="h-9 w-56 rounded-md" />
        <MangaGridSkeleton />
      </div>
    </PageContainer>
  )
}

function BrowseSource() {
  const { sourceId } = Route.useParams()
  const source = tryGetSource(sourceId)

  if (!source) {
    return (
      <PageContainer>
        <ErrorPanel error={new Error(`Unknown source: ${sourceId}`)} />
        <Button asChild variant="outline" size="sm" className="self-start">
          <Link to="/browse">
            <ArrowLeft />
            Back to sources
          </Link>
        </Button>
      </PageContainer>
    )
  }

  // A change of source is a different set of filters and results, so the page
  // starts over rather than reconciling.
  return <SourceBrowser key={source.id} source={source} />
}

function SourceBrowser({ source }: { source: Source }) {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const tab: Tab = search.tab ?? 'popular'
  // A source with no cover art has nothing to put in a tile, so it lists as
  // rows whatever the setting says — a grid of identical placeholders reads as
  // breakage rather than as absence.
  const showCover = hasCoverArt(source)
  const compact = useCompactList() || !showCover
  const query = search.q ?? ''

  // The box stays local so typing is immediate; the URL catches up on a
  // debounce, replacing rather than pushing so Back does not walk back
  // through single letters.
  const [rawQuery, setRawQuery] = useState(query)
  const debouncedQuery = useDebounced(rawQuery, 400)
  // The term the box and the URL last agreed on, so each direction below can
  // tell a change it caused from one it has to follow.
  const syncedQuery = useRef(query)

  useEffect(() => {
    if (debouncedQuery === syncedQuery.current) return
    syncedQuery.current = debouncedQuery
    void navigate({
      search: (prev) => ({
        ...prev,
        q: debouncedQuery.trim() ? debouncedQuery : undefined,
        tab: debouncedQuery.trim() ? ('search' as const) : prev.tab,
      }),
      replace: true,
    })
  }, [debouncedQuery, navigate])

  // Back, forward, or a tag link arriving from a series page re-seeds the box.
  useEffect(() => {
    if (query === syncedQuery.current) return
    syncedQuery.current = query
    setRawQuery(query)
  }, [query])

  const filterData = useQuery({
    queryKey: ['filter-data', source.id],
    queryFn: () => source.fetchFilterData!(),
    enabled: source.supportsFilterFetching && Boolean(source.fetchFilterData),
    staleTime: Infinity,
  })

  const defaultFilters = useMemo(
    () => source.getFilterList(filterData.data),
    [source, filterData.data],
  )
  const filters = useMemo(
    () => (search.f ? applyFilterDiff(defaultFilters, search.f) : defaultFilters),
    [defaultFilters, search.f],
  )
  const filterKey = useMemo(() => JSON.stringify(filters), [filters])

  // Resolving a genre waits for the source's filter list, which for some
  // sources is fetched. `isLoading` is false while the query is disabled, so
  // a source without fetched filters resolves on the first render.
  const filtersReady = !filterData.isLoading
  const requestedGenre = search.genre

  useEffect(() => {
    if (!requestedGenre || !filtersReady) return

    const match = findGenreFilterPath(defaultFilters, requestedGenre)

    // Replaced, not pushed: the unresolved URL is a step of this page's own
    // making, and Back should return to the series it was opened from.
    void navigate({
      search: (prev) => ({
        ...prev,
        genre: undefined,
        tab: 'search' as const,
        // Sources with no genre filter — and a tag the source's list does not
        // carry — fall back to searching for the word.
        ...(match
          ? { f: { ...(prev.f ?? {}), [match.path]: match.value }, q: undefined }
          : { q: requestedGenre }),
      }),
      replace: true,
    })
  }, [requestedGenre, filtersReady, defaultFilters, navigate])

  const results = useInfiniteQuery({
    queryKey: [
      'browse',
      source.id,
      tab,
      tab === 'search' ? query : '',
      tab === 'search' ? filterKey : '',
    ],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => {
      if (tab === 'popular') return source.getPopularManga(pageParam)
      if (tab === 'latest') return source.getLatestUpdates(pageParam)
      return source.getSearchMangaList(pageParam, query, filters)
    },
    getNextPageParam: (lastPage, pages) =>
      lastPage.hasNextPage ? pages.length + 1 : undefined,
  })

  const mangas = useMemo(
    () => results.data?.pages.flatMap((page) => page.mangas) ?? [],
    [results.data],
  )

  const sentinelRef = useInfiniteScroll(
    results.hasNextPage && !results.isFetchingNextPage,
    results.fetchNextPage,
  )

  function handleApplyFilters(next: FilterList) {
    // Pushed, not replaced: applying a filter is a step the reader expects
    // Back to undo.
    void navigate({
      search: (prev) => ({
        ...prev,
        f: encodeFilterDiff(next, defaultFilters),
        tab: 'search' as const,
      }),
    })
  }

  function handleTabChange(next: Tab) {
    void navigate({
      search: (prev) => ({
        ...prev,
        tab: next === 'popular' ? undefined : next,
      }),
    })
  }

  return (
    <PageContainer>
      <header className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon-sm">
          <Link to="/browse" aria-label="Back to sources">
            <ArrowLeft />
          </Link>
        </Button>
        {/* The rating rides along with the name here as well as in the source
            list: opening a source from a library entry or a link never passes
            through that list. */}
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-xl font-semibold tracking-tight">
            {source.name}
          </h1>
          <ContentRatingBadge rating={source.contentRating} />
        </div>
      </header>

      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={rawQuery}
          onChange={(event) => setRawQuery(event.target.value)}
          placeholder={`Search ${source.name}`}
          aria-label={`Search ${source.name}`}
          className="pl-8"
        />
      </div>

      {/* The page scale from `gap-page`, written out: `Tabs` carries its own
          `gap-2`, which tailwind-merge cannot resolve against a custom
          utility. Keeps the strip spaced like every other page block. */}
      <Tabs
        value={tab}
        onValueChange={(value) => handleTabChange(value as Tab)}
        className="gap-2 md:gap-3 lg:gap-4"
      >
        <div className="flex items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="popular">Popular</TabsTrigger>
            {source.supportsLatest && (
              <TabsTrigger value="latest">Latest</TabsTrigger>
            )}
            <TabsTrigger value="search">Search</TabsTrigger>
          </TabsList>

          <FilterDialog
            filters={filters}
            defaults={defaultFilters}
            onApply={handleApplyFilters}
            loading={filterData.isLoading}
          />
        </div>

        <TabsContent value={tab}>
          {results.isPending ? (
            compact ? (
              <MangaListSkeleton showCover={showCover} />
            ) : (
              <MangaGridSkeleton />
            )
          ) : results.isError && mangas.length === 0 ? (
            <ErrorPanel
              error={results.error}
              onRetry={() => void results.refetch()}
            />
          ) : mangas.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No results.
            </p>
          ) : (
            <>
              <MangaGrid
                sourceId={source.id}
                mangas={mangas}
                compact={compact}
                showCover={showCover}
              />

              <div ref={sentinelRef} className="h-px" aria-hidden />

              {results.isFetchingNextPage && (
                <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Loading more
                </div>
              )}

              {/* A later page failing keeps the pages already on screen. */}
              {results.isError && (
                <ErrorPanel
                  error={results.error}
                  onRetry={() => void results.fetchNextPage()}
                />
              )}

              {!results.hasNextPage && !results.isError && (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  End of results
                </p>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>
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

function useInfiniteScroll(enabled: boolean, onLoadMore: () => void) {
  const ref = useRef<HTMLDivElement | null>(null)
  const onLoadMoreRef = useRef(onLoadMore)

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore
  })

  useEffect(() => {
    const element = ref.current
    if (!element || !enabled) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadMoreRef.current()
        }
      },
      { rootMargin: '600px 0px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [enabled])

  return ref
}
