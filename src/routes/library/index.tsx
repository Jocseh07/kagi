import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookHeart, Search, Tags } from 'lucide-react'

import { KindTabs, kindTabOf } from '@/components/kind-tabs'
import type { KindTab } from '@/components/kind-tabs'
import { CategoryPicker } from '@/components/library/category-picker'
import { CategoryTabs } from '@/components/library/category-tabs'
import { LibraryFilterDialog } from '@/components/library/library-filters'
import { LibraryGrid } from '@/components/library/library-grid'
import { useLibraryPrefs } from '@/components/library/prefs'
import { SelectionBar } from '@/components/library/selection-bar'
import { MangaGridSkeleton } from '@/components/manga-grid'
import { MangaListSkeleton } from '@/components/manga-list-row'
import { PageContainer } from '@/components/page-container'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorPanel } from '@/components/ui/error-panel'
import { Input } from '@/components/ui/input'
import { notify } from '@/lib/ui/toast'
import { useDebounced } from '@/lib/use-debounced'
import {
  getCategoriesForManga,
  getCategoryCounts,
  listCategories,
  setCategoriesForManga,
} from '@/lib/db/categories'
import {
  DEFAULT_LIBRARY_FILTERS,
  DEFAULT_LIBRARY_SORT,
  countFavorites,
  countFavoritesByKind,
  markMangaRead,
  queryLibraryCards,
  removeFromLibrary,
} from '@/lib/db/library'
import type {
  LibraryFilters,
  LibrarySort,
  LibrarySortKey,
  LibraryTriState,
} from '@/lib/db/library'
import { useDatabase } from '@/lib/db/provider'
import { dbKeys } from '@/lib/db/query-keys'
import { useCompactList } from '@/lib/display/compact'
import type { ContentKind } from '@/lib/sources/types'

/**
 * What the page is showing, held in the URL so Back undoes a filter, a reload
 * keeps the view, and a link opens the same one for someone else.
 *
 * Every key is optional. Absent means "whatever was stored last time", which
 * is how a bare `/library` still honours the reader's saved preferences.
 */
interface LibrarySearch {
  q?: string
  /** A category id, or `ALL_CATEGORIES` for the "All" tab chosen explicitly. */
  cat?: string
  /** Comics or novels alone. Absent means both, which is the default view. */
  kind?: ContentKind
  filters?: LibraryFilters
  sort?: LibrarySort
}

/** Category ids are ULIDs, so this sentinel can never collide with one. */
const ALL_CATEGORIES = 'all'

const SORT_KEYS: readonly LibrarySortKey[] = [
  'alphabetical',
  'lastRead',
  'lastChecked',
  'unreadCount',
  'totalChapters',
  'latestChapter',
  'dateAdded',
  'random',
]

export const Route = createFileRoute('/library/')({
  validateSearch: (search: Record<string, unknown>): LibrarySearch => {
    const next: LibrarySearch = {}

    if (typeof search.q === 'string' && search.q.trim()) next.q = search.q
    if (typeof search.cat === 'string' && search.cat) next.cat = search.cat

    const kind = kindTabOf(search.kind)
    if (kind) next.kind = kind

    const filters = parseFiltersParam(search.filters)
    if (filters) next.filters = filters

    const sort = parseSortParam(search.sort)
    if (sort) next.sort = sort

    return next
  },
  component: LibraryIndex,
  pendingComponent: LibraryPending,
})

/**
 * The route's shape while its chunk loads.
 *
 * Heading and the Categories link are constants, so they render for real. The
 * tabs and the covers are not, so they are left out or drawn as placeholders
 * rather than guessed at.
 */
function LibraryPending() {
  return (
    <PageContainer>
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-xl font-semibold tracking-tight">Library</h1>
        <Button asChild variant="ghost" size="sm">
          <Link to="/library/categories">
            <Tags />
            Categories
          </Link>
        </Button>
      </header>
      <MangaGridSkeleton count={6} />
    </PageContainer>
  )
}

function parseFiltersParam(value: unknown): LibraryFilters | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const raw = value as Record<string, unknown>
  return {
    downloaded: triOf(raw.downloaded),
    unread: triOf(raw.unread),
    started: triOf(raw.started),
    bookmarked: triOf(raw.bookmarked),
    completed: triOf(raw.completed),
  }
}

function triOf(value: unknown): LibraryTriState {
  return value === 1 || value === 2 ? value : 0
}

function parseSortParam(value: unknown): LibrarySort | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const raw = value as Record<string, unknown>
  const key = SORT_KEYS.find((candidate) => candidate === raw.key)
  if (!key) return undefined
  return {
    key,
    ascending:
      typeof raw.ascending === 'boolean'
        ? raw.ascending
        : DEFAULT_LIBRARY_SORT.ascending,
  }
}

function LibraryIndex() {
  const { status, error } = useDatabase()
  const ready = status === 'ready'
  const queryClient = useQueryClient()

  const urlSearch = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  const { prefs, setFilters, setSort, setCategoryId } = useLibraryPrefs(ready)
  const compact = useCompactList()

  // The URL wins where it says anything; the stored preferences fill the rest,
  // so an existing reader's last filters still apply on a bare `/library`.
  const filters = urlSearch.filters ?? prefs.filters
  const sort = urlSearch.sort ?? prefs.sort
  const categoryId =
    urlSearch.cat === undefined
      ? prefs.categoryId
      : urlSearch.cat === ALL_CATEGORIES
        ? null
        : urlSearch.cat

  const search = urlSearch.q ?? ''

  // Kind lives in the URL alone, not in the stored preferences: it is which
  // half of the library you are looking at right now, not a saved filter.
  const kind = urlSearch.kind

  // The box stays local so typing is immediate; the URL catches up on a
  // debounce, replacing so Back does not walk back through single letters.
  const [rawSearch, setRawSearch] = useState(search)
  const debouncedSearch = useDebounced(rawSearch, 300)
  const syncedSearch = useRef(search)

  useEffect(() => {
    if (debouncedSearch === syncedSearch.current) return
    syncedSearch.current = debouncedSearch
    void navigate({
      search: (prev) => ({
        ...prev,
        q: debouncedSearch.trim() ? debouncedSearch : undefined,
      }),
      replace: true,
    })
  }, [debouncedSearch, navigate])

  useEffect(() => {
    if (search === syncedSearch.current) return
    syncedSearch.current = search
    setRawSearch(search)
  }, [search])

  // Both halves are written on every change: the URL is what this page reads,
  // the settings table is what the next visit falls back to.
  function applyFilters(next: LibraryFilters) {
    setFilters(next)
    void navigate({ search: (prev) => ({ ...prev, filters: next }) })
  }

  function applySort(next: LibrarySort) {
    setSort(next)
    void navigate({ search: (prev) => ({ ...prev, sort: next }) })
  }

  function resetFiltersAndSort() {
    setFilters(DEFAULT_LIBRARY_FILTERS)
    setSort(DEFAULT_LIBRARY_SORT)
    void navigate({
      search: (prev) => ({
        ...prev,
        filters: DEFAULT_LIBRARY_FILTERS,
        sort: DEFAULT_LIBRARY_SORT,
      }),
    })
  }

  function applyKind(next: KindTab) {
    void navigate({
      search: (prev) => ({ ...prev, kind: next === 'all' ? undefined : next }),
    })
  }

  function applyCategory(next: string | null) {
    setCategoryId(next)
    void navigate({
      search: (prev) => ({ ...prev, cat: next ?? ALL_CATEGORIES }),
    })
  }

  // Fixed per visit so the random sort does not reshuffle on every refetch.
  const [randomSeed] = useState(() => Date.now() % 1_000_000)

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [pickerOpen, setPickerOpen] = useState(false)
  const anchor = useRef<number | null>(null)

  const categories = useQuery({
    queryKey: dbKeys.categories,
    queryFn: listCategories,
    enabled: ready,
    staleTime: 0,
  })

  const categoryCounts = useQuery({
    queryKey: [...dbKeys.categories, 'counts', kind],
    queryFn: () => getCategoryCounts(kind),
    enabled: ready,
    staleTime: 0,
  })

  const favoriteCount = useQuery({
    queryKey: [...dbKeys.library, 'count'],
    queryFn: countFavorites,
    enabled: ready,
    staleTime: 0,
  })

  const kindCounts = useQuery({
    queryKey: [...dbKeys.library, 'kind-counts'],
    queryFn: countFavoritesByKind,
    enabled: ready,
    staleTime: 0,
  })

  const library = useQuery({
    queryKey: [...dbKeys.library, kind, categoryId, filters, sort, search],
    queryFn: () =>
      queryLibraryCards({
        filters,
        sort,
        search,
        categoryId,
        kind,
        randomSeed,
      }),
    enabled: ready,
    staleTime: 0,
  })

  const entries = useMemo(() => library.data ?? [], [library.data])

  // A category the user deleted elsewhere must not leave the page filtering on
  // a tab that no longer exists.
  useEffect(() => {
    if (!categoryId || !categories.isSuccess) return
    if (categories.data.some((item) => item.id === categoryId)) return
    setCategoryId(null)
    void navigate({
      search: (prev) => ({ ...prev, cat: undefined }),
      replace: true,
    })
  }, [categoryId, categories.isSuccess, categories.data, setCategoryId, navigate])

  function clearSelection() {
    setSelected(new Set())
    anchor.current = null
  }

  function handleSelect(index: number, shiftKey: boolean) {
    const entry = entries[index]
    if (!entry) return

    setSelected((current) => {
      const next = new Set(current)
      if (shiftKey && anchor.current !== null) {
        const start = Math.min(anchor.current, index)
        const end = Math.max(anchor.current, index)
        for (let cursor = start; cursor <= end; cursor += 1) {
          const item = entries[cursor]
          if (item) next.add(item.id)
        }
        return next
      }
      if (next.has(entry.id)) next.delete(entry.id)
      else next.add(entry.id)
      return next
    })
    anchor.current = index
  }

  const selectedIds = useMemo(() => [...selected], [selected])

  const selectionCategories = useQuery({
    queryKey: [...dbKeys.categories, 'selection', selectedIds],
    queryFn: () => getCategoriesForManga(selectedIds),
    enabled: ready && pickerOpen && selectedIds.length > 0,
    staleTime: 0,
  })

  const sharedCategories = useMemo(
    () => intersect(selectedIds, selectionCategories.data ?? {}),
    [selectedIds, selectionCategories.data],
  )

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: dbKeys.library })
    void queryClient.invalidateQueries({ queryKey: dbKeys.categories })
    void queryClient.invalidateQueries({ queryKey: dbKeys.allChapters })
  }

  // Each of these empties the selection on the way out, so the bar that
  // triggered them is gone before the result lands — the toast is the only
  // thing left that can report it.
  const assign = useMutation({
    mutationFn: (categoryIds: string[]) =>
      setCategoriesForManga(selectedIds, categoryIds),
    onSuccess: () => {
      notify.success(`Categories updated for ${selectedIds.length} series`)
      setPickerOpen(false)
      clearSelection()
      invalidate()
    },
    onError: (error) => notify.error('Could not update categories', error),
  })

  const markRead = useMutation({
    mutationFn: () => markMangaRead(selectedIds),
    onSuccess: () => {
      notify.success(`Marked ${selectedIds.length} series as read`)
      clearSelection()
      invalidate()
    },
    onError: (error) => notify.error('Could not mark those as read', error),
  })

  const remove = useMutation({
    mutationFn: () => removeFromLibrary(selectedIds),
    onSuccess: () => {
      notify.success(`Removed ${selectedIds.length} series from library`)
      clearSelection()
      invalidate()
    },
    onError: (error) => notify.error('Could not remove those series', error),
  })

  const busy = assign.isPending || markRead.isPending || remove.isPending
  const total = favoriteCount.data ?? 0
  const byKind = kindCounts.data ?? { comic: 0, novel: 0 }
  // What the chosen tab holds, which is what the category strip beneath it is
  // counting within.
  const scopeTotal = kind ? byKind[kind] : total
  const filtering = search.trim().length > 0 || hasActiveFilter(filters)

  return (
    <PageContainer>
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-xl font-semibold tracking-tight">Library</h1>
        <Button asChild variant="ghost" size="sm">
          <Link to="/library/categories">
            <Tags />
            Categories
          </Link>
        </Button>
      </header>

      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={rawSearch}
          onChange={(event) => setRawSearch(event.target.value)}
          placeholder="Search your library"
          aria-label="Search your library"
          className="pl-8"
        />
      </div>

      <div className="flex items-center gap-3">
        {/* Only worth a switch once there is something on both sides of it. A
            library of comics alone would otherwise carry a permanent Novels tab
            reading zero. Kept whenever a kind is chosen regardless, so emptying
            one side cannot strand the reader on a filter with no way out. */}
        {(kind !== undefined || (byKind.comic > 0 && byKind.novel > 0)) && (
          // Shrinks and scrolls rather than pushing Filter off a narrow
          // screen, since the counts beside each label have no fixed width.
          <div className="min-w-0 overflow-x-auto">
            <KindTabs
              label="Content type"
              value={kind ?? 'all'}
              counts={{ all: total, comic: byKind.comic, novel: byKind.novel }}
              onChange={(next) => {
                clearSelection()
                applyKind(next)
              }}
            />
          </div>
        )}
        {/* Anchored right whether or not the tabs above render, so Filter does
            not move between a one-kind library and a two-kind one. */}
        <div className="ml-auto">
          <LibraryFilterDialog
            filters={filters}
            sort={sort}
            onFiltersChange={applyFilters}
            onSortChange={applySort}
            onReset={resetFiltersAndSort}
          />
        </div>
      </div>

      <CategoryTabs
        categories={categories.data ?? []}
        counts={categoryCounts.data ?? {}}
        total={scopeTotal}
        selected={categoryId}
        onSelect={(next) => {
          clearSelection()
          applyCategory(next)
        }}
      />

      {status === 'error' ? (
        <ErrorPanel
          error={error ?? new Error('The library database is unavailable.')}
        />
      ) : library.isError ? (
        <ErrorPanel error={library.error} onRetry={() => void library.refetch()} />
      ) : library.isPending ? (
        compact ? (
          <MangaListSkeleton count={8} />
        ) : (
          <MangaGridSkeleton count={6} />
        )
      ) : total === 0 ? (
        <EmptyLibrary />
      ) : entries.length === 0 ? (
        <NoMatches filtering={filtering} kind={kind} kindTotal={scopeTotal} />
      ) : (
        <LibraryGrid
          entries={entries}
          selected={selected}
          compact={compact}
          onSelect={handleSelect}
        />
      )}

      {selected.size > 0 && (
        <SelectionBar
          count={selected.size}
          busy={busy}
          onSetCategories={() => setPickerOpen(true)}
          onMarkRead={() => markRead.mutate()}
          onRemove={() => remove.mutate()}
          onClear={clearSelection}
        />
      )}

      <CategoryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        categories={categories.data ?? []}
        initial={sharedCategories}
        count={selected.size}
        busy={assign.isPending}
        onApply={(categoryIds) => assign.mutate(categoryIds)}
      />
    </PageContainer>
  )
}

/** Category ids every selected series already belongs to. */
function intersect(
  mangaIds: readonly string[],
  assignments: Record<string, string[]>,
): string[] {
  const [first, ...rest] = mangaIds
  if (!first) return []
  return (assignments[first] ?? []).filter((categoryId) =>
    rest.every((mangaId) => (assignments[mangaId] ?? []).includes(categoryId)),
  )
}

function hasActiveFilter(filters: LibraryFilters): boolean {
  return Object.values(filters).some((state) => state !== 0)
}

/**
 * Why the grid is empty when the library itself is not.
 *
 * The kind tab is checked before the filters: on an empty Novels tab, "nothing
 * matches your filters" sends the reader to clear filters that were never the
 * reason.
 */
function NoMatches({
  filtering,
  kind,
  kindTotal,
}: {
  filtering: boolean
  kind: ContentKind | undefined
  kindTotal: number
}) {
  if (kind && kindTotal === 0) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        {kind === 'novel'
          ? 'No novels in your library yet.'
          : 'No comics in your library yet.'}
      </p>
    )
  }

  return (
    <p className="py-16 text-center text-sm text-muted-foreground">
      {filtering
        ? 'Nothing matches the current search and filters.'
        : 'This category is empty.'}
    </p>
  )
}

function EmptyLibrary() {
  return (
    <EmptyState
      icon={BookHeart}
      title="No favourites yet"
      description="Series you add to your library will show up here."
      action={
        <Button asChild variant="outline" size="sm">
          <Link to="/browse">Browse sources</Link>
        </Button>
      }
    />
  )
}
