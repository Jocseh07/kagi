import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowUpToLine,
  Check,
  CloudOff,
  Globe,
  Heart,
  Play,
  Search,
} from 'lucide-react'

import { ChapterFilters } from '@/components/chapter-filters'
import { ChapterGroupSelect } from '@/components/chapter-group-select'
import {
  UNGROUPED,
  UNGROUPED_LABEL,
  isGroupStarted,
  pickFollowedGroup,
  scanlatorKey,
} from '@/lib/chapters/filter-state'
import { scopeToGroups } from '@/lib/chapters/scope'
import { useChapterFilters } from '@/lib/chapters/use-chapter-filters'
import { ChapterDownloadButton } from '@/components/download/chapter-download-button'
import { ExportCbzButton } from '@/components/download/export-cbz-button'
import { QueueUnreadButton } from '@/components/download/enqueue-actions'
import {
  pendingChapterUrls,
  useQueueItemsByChapterUrl,
} from '@/components/download/queue-actions'
import type {
  ChapterFilterState,
  ChapterTriState,
  ScanlatorOption,
} from '@/lib/chapters/filter-state'
import { FoldRow } from '@/components/fold-row'
import { ExpandableDescription } from '@/components/manga/expandable-description'
import {
  MangaActionButton,
  MangaActionRow,
  MangaActionSlot,
} from '@/components/manga/manga-action-row'
import { MangaInfoHeader } from '@/components/manga/manga-info-header'
import { useLibraryEntry } from '@/components/manga/use-library-entry'
import type { LibraryEntryState } from '@/components/manga/use-library-entry'
import { usePageBack } from '@/components/page-back'
import type { PageBack } from '@/components/page-back'
import { PageContainer } from '@/components/page-container'
import { Button } from '@/components/ui/button'
import { ErrorPanel } from '@/components/ui/error-panel'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { VirtualList } from '@/components/virtual-list'
import { useDatabaseReady } from '@/lib/db/provider'
import { dbKeys } from '@/lib/db/query-keys'
import { useCompactList } from '@/lib/display/compact'
import {
  cacheMangaDetails,
  getMangaByUrl,
  listChapters,
  markChapterRead,
  markChaptersRead,
  upsertChapters,
  upsertManga,
} from '@/lib/db/repositories'
import { lastReadScanlator } from '@/lib/db/history'
import type { Chapter } from '@/lib/db/schema'
import type { QueueItem } from '@/lib/download/queue-types'
import { deleteSavedAfterRead } from '@/lib/offline/delete-after-read'
import { getSource } from '@/lib/sources/registry'
import {
  chapterContentQueryOptions,
  storedUpdateQueryOptions,
} from '@/lib/reader/chapter-queries'
import { useOnline } from '@/lib/offline/use-online'
import { readPercent } from '@/lib/text/progress'
import { chunkRows, useListColumns } from '@/lib/virtual/use-grid-columns'
import { usePageVirtualizer } from '@/lib/virtual/use-page-virtualizer'
import { notify } from '@/lib/ui/toast'
import { useDebounced } from '@/lib/use-debounced'
import { cn } from '@/lib/utils'
import { isTextSource } from '@/lib/sources/types'
import type {
  MangaUpdate,
  SChapter,
  SManga,
  Source,
} from '@/lib/sources/types'

export const Route = createFileRoute('/manga/$sourceId/$slug')({
  component: MangaDetail,
  pendingComponent: MangaDetailPending,
})

/**
 * The route's shape while its chunk loads, identical to the shape it shows
 * while the series itself is being fetched — so crossing from one to the other
 * moves nothing on screen.
 */
function MangaDetailPending() {
  return (
    <PageContainer>
      <DetailSkeleton />
    </PageContainer>
  )
}

function MangaDetail() {
  const { sourceId, slug } = Route.useParams()
  const source = tryGetSource(sourceId)

  if (!source) {
    return (
      <PageContainer>
        <ErrorPanel error={new Error(`Unknown source: ${sourceId}`)} />
      </PageContainer>
    )
  }

  return <MangaDetailView key={`${sourceId}/${slug}`} source={source} slug={slug} />
}

function MangaDetailView({ source, slug }: { source: Source; slug: string }) {
  const stub = useMemo<SManga>(
    () => ({
      url: `/series/${slug}`,
      title: slug,
      status: 'unknown',
      initialized: false,
      memo: { slug },
    }),
    [slug],
  )

  const detail = useQuery<MangaUpdate>({
    queryKey: ['manga', source.id, slug],
    queryFn: () =>
      source.getMangaUpdate(stub, { fetchDetails: true, fetchChapters: true }),
  })

  /**
   * The copy this device already holds, read in parallel with the fetch above
   * rather than after it fails.
   *
   * A series in the library was written whole when it was added, so everything
   * this page draws is already here. Waiting on the source to show it means a
   * skeleton on every visit and an error panel over a series that is sitting
   * on the device, which is the state that matters on a train.
   */
  const databaseReady = useDatabaseReady()
  const stored = useQuery({
    ...storedUpdateQueryOptions(source.id, slug),
    enabled: databaseReady,
    // A local read, and the writes below move it. Held fresh it would outlive
    // its own refresh, like every other database query on this page.
    staleTime: 0,
  })

  // The fetched copy the moment there is one, the stored copy until then.
  const update = detail.data ?? stored.data ?? null

  /**
   * Keeps the stored copy current from the fetch that just landed.
   *
   * Only for a series that is already here: `cacheMangaDetails` updates and
   * never inserts, and the chapter write is skipped without a row to hang it
   * on, so browsing a series you do not follow writes nothing. Neither call
   * marks the row for sync — see `cacheMangaDetails`.
   */
  useEffect(() => {
    const fetched = detail.data
    if (!databaseReady || !fetched) return

    let abandoned = false
    void (async () => {
      try {
        const row = await getMangaByUrl(source.id, fetched.manga.url)
        if (!row || abandoned) return
        await cacheMangaDetails(source.id, fetched.manga)
        if (fetched.chapters.length > 0 && !abandoned) {
          await upsertChapters(row.id, fetched.chapters)
        }
      } catch {
        // A cache that could not be refreshed is a cache that stays as it was.
      }
    })()

    return () => {
      abandoned = true
    }
  }, [databaseReady, detail.data, source.id])

  // One target, two homes: below `md` the app header carries it centred, and
  // from `md` up it rides on the cover inside the info header.
  const back = useMemo<PageBack>(
    () => ({
      to: '/browse/$sourceId',
      params: { sourceId: source.id },
      label: source.name,
    }),
    [source.id, source.name],
  )

  usePageBack(back)

  // Nothing to show yet from either side. The stored read is local and fast,
  // so this is the first moments of a series that was never here.
  const waiting = detail.isPending && (stored.isPending || stored.data === null)

  return (
    <PageContainer>
      {waiting ? (
        <DetailSkeleton />
      ) : update === null ? (
        <ErrorPanel error={detail.error} onRetry={() => void detail.refetch()} />
      ) : (
        <>
          {detail.isError && <StaleNotice onRetry={() => void detail.refetch()} />}
          <Loaded source={source} slug={slug} update={update} back={back} />
        </>
      )}
    </PageContainer>
  )
}

/**
 * Shown over a series drawn from the device after the source refused.
 *
 * Suppressed while the browser is offline: `OfflineBanner` already says so at
 * the top of every page, and a second notice for the same fact is one too
 * many. Online, the source itself is down and nothing else on screen says it.
 */
function StaleNotice({ onRetry }: { onRetry: () => void }) {
  const online = useOnline()
  if (!online) return null

  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5"
    >
      <CloudOff aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">
        Showing your saved copy. Could not reach the source.
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

function Loaded({
  source,
  slug,
  update,
  back,
}: {
  source: Source
  slug: string
  update: MangaUpdate
  back: PageBack
}) {
  const { manga, chapters } = update
  const compact = useCompactList()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const rows = useChapterRows(source.id, manga)
  // Held here rather than only inside the Heart button, because the read and
  // download paths below need to know whether the series is already followed.
  const library = useLibraryEntry(source.id, manga, chapters)
  const {
    filters: storedFilters,
    setFilters,
    loaded: filtersLoaded,
  } = useChapterFilters(source.id, manga.url)
  const lastReadGroup = useLastReadGroup(source.id, manga)
  // Deliberately not persisted: a search narrows the list for the moment you
  // are looking, unlike the filter and sort choices.
  const [search, setSearch] = useState('')
  /**
   * Folding runs off the read state as it was when you marked a chapter, held
   * for a beat, so the row stays where it is long enough to be seen turning
   * read instead of vanishing under the cursor. Everything else — styling,
   * counts, the row's own buttons — reads `rows` and updates at once.
   */
  const [heldRows, setHeldRows] = useState<ChapterRows | null>(null)
  const foldRows = heldRows ?? rows
  // A second mark inside the window rides the running timer rather than
  // restarting it, so the list can never be held open indefinitely.
  const holdFolds = useCallback(() => setHeldRows((held) => held ?? rows), [rows])

  useEffect(() => {
    if (!heldRows) return
    const id = window.setTimeout(() => setHeldRows(null), FOLD_DELAY_MS)
    return () => window.clearTimeout(id)
  }, [heldRows])
  // The box stays responsive while the pass over the chapter list waits for the
  // typing to stop; the empty state follows the settled term so it always
  // describes the rows actually on screen.
  const debouncedSearch = useDebounced(search, 200)
  const searching = debouncedSearch.trim().length > 0

  const ascending = useMemo(
    () => [...chapters].sort((a, b) => a.chapterNumber - b.chapterNumber),
    [chapters],
  )
  // Every group, whatever is selected: the dropdown has to keep offering the
  // ones being filtered out, and the auto-selection below is derived from it.
  const scanlators = useMemo(
    () => collectScanlators(chapters, storedFilters.scanlators, rows),
    [chapters, storedFilters.scanlators, rows],
  )

  /**
   * The one group this series is read from.
   *
   * A stored choice wins while its group is still on offer. Otherwise the
   * series follows the group of the chapter last opened, or the best guess.
   * Derived rather than only written, so it can neither race the settings read
   * nor flicker to "all" before the read lands. A single-group series has
   * nothing to follow and stays unscoped.
   */
  const followed = useMemo(() => {
    if (scanlators.length < 2) return null
    const stored = storedFilters.scanlators[0]
    if (
      stored !== undefined &&
      scanlators.some((option) => option.name === stored && option.count > 0)
    ) {
      return stored
    }
    return pickFollowedGroup(scanlators, lastReadGroup)
  }, [scanlators, storedFilters.scanlators, lastReadGroup])

  const filters = useMemo(
    () => ({
      ...storedFilters,
      scanlators: followed === null ? [] : [followed],
    }),
    [storedFilters, followed],
  )

  /**
   * Written back for a followed series only, so the library's badge counts
   * and the update checker see the same group as the page. A series merely
   * browsed leaves nothing behind.
   */
  useEffect(() => {
    if (!filtersLoaded || !library.favorite || followed === null) return
    if (storedFilters.scanlators[0] === followed) return
    setFilters({ ...storedFilters, scanlators: [followed] })
  }, [filtersLoaded, library.favorite, followed, storedFilters, setFilters])

  const sorted = useMemo(
    () => arrangeChapters(chapters, filters, rows, debouncedSearch),
    [chapters, filters, rows, debouncedSearch],
  )
  // Folding read chapters away is pointless once the list is already filtered
  // by read state, and actively harmful during a search: a match behind a shut
  // fold reads as no match at all.
  const foldable = filters.unread === 0 && !searching

  /**
   * The list, split by group when more than one is on show.
   *
   * Headers only earn their space when there is something to tell apart, so a
   * single selected group — the common case once a series is being followed —
   * renders as one unlabelled run exactly as it did before.
   */
  const groupedSegments = useMemo(
    () => groupSegments(sorted, foldRows, foldable, scanlators),
    [sorted, foldRows, foldable, scanlators],
  )
  /**
   * The series as the reader is actually following it: one group's chapters,
   * or all of them when no group is picked.
   *
   * Everything that walks the list in order reads this rather than `ascending`
   * — where to resume, what counts as unread, and what a download batch takes.
   * On an aggregator the other groups are a parallel copy of the same series,
   * and counting them makes every one of those answers wrong.
   */
  const scopedAscending = useMemo(
    () => scopeToGroups(ascending, filters.scanlators),
    [ascending, filters.scanlators],
  )

  const resume = useMemo(
    () => pickResume(scopedAscending, rows),
    [scopedAscending, rows],
  )
  const queueItems = useQueueItemsByChapterUrl(source.id)
  // The bulk action only picks chapters with no outstanding work; a failed row
  // is still a candidate, so it cannot key off the map alone.
  const queuedUrls = useMemo(() => pendingChapterUrls(queueItems), [queueItems])
  const webUrl = source.getMangaWebUrl(manga)

  const firstUnread = useMemo(
    () =>
      scopedAscending.find(
        (chapter) => !(rows.get(chapter.url)?.read ?? false),
      ) ?? null,
    [scopedAscending, rows],
  )
  // "Mark previous as read" is only worth offering above the earliest unread
  // chapter, and finding that once beats scanning the list per row.
  const firstUnreadNumber = firstUnread?.chapterNumber ?? Number.POSITIVE_INFINITY

  const boundary = useMemo(
    () => findResumeBoundary(sorted, rows, firstUnread?.url ?? null),
    [sorted, rows, firstUnread],
  )

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: dbKeys.manga(source.id, manga.url),
    })
    void queryClient.invalidateQueries({ queryKey: dbKeys.allChapters })
    void queryClient.invalidateQueries({ queryKey: dbKeys.history })
    void queryClient.invalidateQueries({ queryKey: dbKeys.library })
  }, [queryClient, source.id, manga.url])

  /** Marking read can free downloads, so the saved views have to be told too. */
  const refreshSaved = useCallback(() => {
    // Prefix key: which series' ids to drop is not known here, and the list is
    // only refetched for the series actually on screen.
    void queryClient.invalidateQueries({ queryKey: ['db', 'saved-chapter-ids'] })
    void queryClient.invalidateQueries({ queryKey: dbKeys.savedChapters })
    void queryClient.invalidateQueries({ queryKey: dbKeys.storage })
  }, [queryClient])

  const toggleRead = useMutation({
    mutationFn: async ({
      chapter,
      read,
    }: {
      chapter: SChapter
      read: boolean
    }) => {
      const row = await ensureChapterRow(source.id, manga, chapter)
      await markChapterRead(row.id, read)
      if (read) {
        await deleteSavedAfterRead([row.id])
        refreshSaved()
      }
    },
    onSuccess: (_data, { read }) => {
      refresh()
      // Only reading forward suggests following the series; unticking one is
      // a correction, and a correction is no moment to ask for a commitment.
      if (read) library.promptIfMissing()
    },
    onError: (error) => notify.error('Could not update read state', error),
  })

  /** Everything below a chapter, in two bulk writes however long the backlog. */
  const markPrevious = useMutation({
    mutationFn: async (target: SChapter) => {
      // Scoped: another group's chapter 40 is not something you have read
      // because you reached chapter 41 in this one.
      const earlier = scopedAscending.filter(
        (item) => item.chapterNumber < target.chapterNumber,
      )
      if (earlier.length === 0) return
      const mangaRow = await upsertManga(source.id, manga)
      const stored = await upsertChapters(mangaRow.id, earlier)
      const freshlyRead = stored.filter((row) => !row.read).map((row) => row.id)
      await markChaptersRead(freshlyRead, true)
      await deleteSavedAfterRead(freshlyRead)
      refreshSaved()
      return freshlyRead.length
    },
    onSuccess: (marked) => {
      refresh()
      if (!marked) return
      notify.success(
        `Marked ${marked} ${marked === 1 ? 'chapter' : 'chapters'} as read`,
      )
      library.promptIfMissing()
    },
    onError: (error) => notify.error('Could not update read state', error),
  })

  const busyUrl = toggleRead.isPending
    ? toggleRead.variables.chapter.url
    : markPrevious.isPending
      ? markPrevious.variables.url
      : null

  // The chapter travels as an argument rather than in a closure: a row is
  // memoized, and a fresh handler per row would defeat that on every scroll
  // frame — which is the whole cost the memo exists to avoid.
  const toggleReadMutate = toggleRead.mutate
  const markPreviousMutate = markPrevious.mutate

  // Only marking *read* holds the fold back: unmarking opens the list up,
  // which never pulls a row out from under you.
  const handleToggleRead = useCallback(
    (chapter: SChapter, read: boolean) => {
      if (read) holdFolds()
      toggleReadMutate({ chapter, read })
    },
    [toggleReadMutate, holdFolds],
  )

  const handleMarkPrevious = useCallback(
    (chapter: SChapter) => {
      holdFolds()
      markPreviousMutate(chapter)
    },
    [markPreviousMutate, holdFolds],
  )

  // The browse page turns this into the source's own genre filter, since a
  // tag is a genre and not a title: searching for "Action" as text finds
  // series *called* Action, which is almost never any.
  const browseTag = useCallback(
    (tag: string) => {
      void navigate({
        to: '/browse/$sourceId',
        params: { sourceId: source.id },
        search: { genre: tag },
      })
    },
    [navigate, source.id],
  )

  const markingPrevious = markPrevious.isPending

  /**
   * Stable so that scrolling — which re-renders the list on every frame —
   * hands each memoized row the props it already had.
   */
  const renderRow = useCallback(
    (chapter: SChapter, className?: string) => (
      <ChapterRow
        source={source}
        slug={slug}
        manga={manga}
        chapter={chapter}
        row={rows.get(chapter.url)}
        queueItem={queueItems.get(chapter.url)}
        busy={busyUrl === chapter.url || markingPrevious}
        canMarkPrevious={chapter.chapterNumber > firstUnreadNumber}
        compact={compact}
        className={className}
        onToggleRead={handleToggleRead}
        onMarkPrevious={handleMarkPrevious}
        onQueued={library.promptIfMissing}
      />
    ),
    [
      source,
      slug,
      manga,
      rows,
      queueItems,
      busyUrl,
      markingPrevious,
      firstUnreadNumber,
      compact,
      handleToggleRead,
      handleMarkPrevious,
      library.promptIfMissing,
    ],
  )

  return (
    /* The rail is the whole point of the wide layout: a series can list a
       thousand chapters, and the cover and its actions should not scroll away
       while you are working through them. Below `md` it is simply the top of
       one column, in Mihon's order. */
    <div className="md:grid md:grid-cols-[18rem_1fr] md:items-start md:gap-8">
      <div className="flex flex-col gap-4 md:sticky md:top-4">
        <MangaInfoHeader
          manga={manga}
          sourceName={source.name}
          back={back}
          inLibrary={library.favorite}
        />

        {/* The one action the page exists for, so it gets its own line and the
            full width rather than a quarter of the strip. Absent only when the
            series has no chapters at all and there is nothing to point at. */}
        {resume && (
          <Button asChild className="w-full">
            <Link
              to="/reader/$sourceId/$slug/$chapter"
              params={{
                sourceId: source.id,
                slug,
                chapter: chapterKey(resume.chapter),
              }}
              title={resume.chapter.name}
            >
              <Play className="size-5 sm:size-4" />
              {resume.label}
            </Link>
          </Button>
        )}

        <MangaActionRow>
          <FavoriteButton library={library} />

          {!source.isLocal && (
            <QueueUnreadButton
              sourceId={source.id}
              manga={manga}
              chapters={scopedAscending}
              rows={rows}
              queuedUrls={queuedUrls}
              onQueued={library.promptIfMissing}
            />
          )}

          {/* Offline sources have no web URL; an empty href would resolve to
              the current page and open a second copy of the app. */}
          {webUrl && (
            <MangaActionSlot>
              <MangaActionButton asChild icon={Globe} label="Web">
                <a href={webUrl} target="_blank" rel="noreferrer noopener">
                  <Globe className="size-5 sm:size-4" />
                  Web
                </a>
              </MangaActionButton>
            </MangaActionSlot>
          )}
        </MangaActionRow>
      </div>

      <div className="flex min-w-0 flex-col gap-4 max-md:mt-4">
        <ExpandableDescription
          description={manga.description}
          genres={manga.genre}
          onBrowseTag={browseTag}
          onCopyTag={copyTag}
        />

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="shrink-0 text-sm font-semibold">
            {sorted.length === chapters.length
              ? `${chapters.length} chapter${chapters.length === 1 ? '' : 's'}`
              : `${sorted.length} of ${chapters.length} chapters`}
          </h2>
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search chapters"
                aria-label="Search chapters"
                className="pl-8"
              />
            </div>
            <ChapterGroupSelect
              groups={scanlators}
              value={followed}
              onChange={(next) => setFilters({ ...filters, scanlators: [next] })}
            />
            <ChapterFilters state={filters} onChange={setFilters} />
          </div>
        </div>

        {chapters.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No chapters available.
          </p>
        ) : sorted.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {searching
              ? 'No chapters match your search.'
              : 'No chapters match the current filter.'}
          </p>
        ) : (
          <ChapterList
            blocks={groupedSegments}
            boundary={boundary}
            compact={compact}
            renderRow={renderRow}
          />
        )}

      </div>
    </div>
  )
}

/** Tags are copyable in Mihon; a clipboard refusal is not worth reporting. */
function copyTag(tag: string) {
  void navigator.clipboard?.writeText(tag).catch(() => undefined)
}

/**
 * The Heart. Reads and writes the membership the page already holds, so the
 * button and the prompt can never disagree about what "in library" means.
 */
function FavoriteButton({ library }: { library: LibraryEntryState }) {
  const { ready, favorite, busy, setFavorite: write } = library

  return (
    <MangaActionSlot>
      <MangaActionButton
        icon={Heart}
        iconClassName={favorite ? 'fill-current' : undefined}
        label={favorite ? 'In library' : 'Add'}
        active={favorite}
        disabled={!ready || busy}
        aria-pressed={favorite}
        onClick={() => write(!favorite)}
      />
    </MangaActionSlot>
  )
}

/**
 * The chapter list as one flat sequence of rows.
 *
 * A series can list thousands of chapters, so only the rows in view are drawn.
 * That rules out a collapsible panel around the read runs — a virtualizer has
 * to be able to index and measure every row — so a fold is an ordinary row and
 * the chapters behind it are simply left out of the sequence while it is shut.
 */
type ChapterListRow =
  | { kind: 'group'; key: string; name: string; count: number }
  | { kind: 'fold'; key: string; count: number; range: string }
  | { kind: 'divider'; key: string }
  /**
   * One line of chapters. Compact mode fits two or three side by side on a
   * wide screen; everywhere else this holds exactly one, which is what the
   * list has always drawn.
   */
  | { kind: 'chapters'; key: string; chapters: SChapter[] }

/**
 * Every row kind is drawn at a fixed height, so these are exact rather than
 * estimates. That exactness is what lets the list skip per-row measurement
 * (`measure={false}` below): nothing ever corrects a wrong value, so a row's
 * layout and its constant here must change together.
 */
/** How long a freshly read chapter stays visible before the fold closes. */
const FOLD_DELAY_MS = 900

const CHAPTER_ROW_HEIGHT = 60
const FOLD_ROW_HEIGHT = 42
const DIVIDER_ROW_HEIGHT = 30
const GROUP_ROW_HEIGHT = 36

/** The same four rows under "compact list view". */
const COMPACT_CHAPTER_ROW_HEIGHT = 48
const COMPACT_FOLD_ROW_HEIGHT = 34
const COMPACT_DIVIDER_ROW_HEIGHT = 24
const COMPACT_GROUP_ROW_HEIGHT = 30

function buildChapterRows(
  blocks: readonly ChapterGroupBlock[],
  boundary: ResumeBoundary | null,
  openFolds: ReadonlySet<string>,
  /** Chapters per line. Group headers, folds and dividers always span all. */
  columns: number,
): ChapterListRow[] {
  const rows: ChapterListRow[] = []

  for (const block of blocks) {
    if (block.name !== null) {
      rows.push({
        kind: 'group',
        key: block.key,
        name: block.name,
        count: block.count,
      })
    }

    block.segments.forEach((segment, index) => {
      // Namespaced by block: a bare index would have every group's first fold
      // sharing one key, so opening one would open them all.
      const foldKey = `fold-${block.key}-${index}`
      if (segment.kind === 'read') {
        rows.push({
          kind: 'fold',
          key: foldKey,
          count: segment.chapters.length,
          range: chapterRangeLabel(segment.chapters),
        })
        if (!openFolds.has(foldKey)) return
      }

      // Buffered rather than pushed one by one: a run of chapters is what
      // gets packed across columns, and a divider ends the run it interrupts.
      let run: SChapter[] = []

      const flush = () => {
        for (const line of chunkRows(run, columns)) {
          rows.push({ kind: 'chapters', key: line[0]!.url, chapters: line })
        }
        run = []
      }

      for (const chapter of segment.chapters) {
        const marker = boundary?.url === chapter.url ? boundary.side : null
        if (marker === 'before') {
          flush()
          rows.push({ kind: 'divider', key: `divider-before-${chapter.url}` })
        }
        run.push(chapter)
        if (marker === 'after') {
          flush()
          rows.push({ kind: 'divider', key: `divider-after-${chapter.url}` })
        }
      }

      flush()
    })
  }

  return rows
}

function ChapterList({
  blocks,
  boundary,
  compact,
  renderRow,
}: {
  blocks: readonly ChapterGroupBlock[]
  boundary: ResumeBoundary | null
  compact: boolean
  renderRow(chapter: SChapter, className?: string): ReactNode
}) {
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  // Subscribed to either way — a hook cannot be conditional — but only the
  // compact list spends the columns it reports.
  const listColumns = useListColumns()
  const columns = compact ? listColumns : 1

  const rows = useMemo(
    () => buildChapterRows(blocks, boundary, openFolds, columns),
    [blocks, boundary, openFolds, columns],
  )

  const toggleFold = useCallback((key: string) => {
    setOpenFolds((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])

  const { listRef, virtualizer, scrollMargin } = usePageVirtualizer({
    count: rows.length,
    estimateSize: useCallback(
      (index: number) => {
        const row = rows[index]
        if (row?.kind === 'group') {
          return compact ? COMPACT_GROUP_ROW_HEIGHT : GROUP_ROW_HEIGHT
        }
        if (row?.kind === 'fold') {
          return compact ? COMPACT_FOLD_ROW_HEIGHT : FOLD_ROW_HEIGHT
        }
        if (row?.kind === 'divider') {
          return compact ? COMPACT_DIVIDER_ROW_HEIGHT : DIVIDER_ROW_HEIGHT
        }
        return compact ? COMPACT_CHAPTER_ROW_HEIGHT : CHAPTER_ROW_HEIGHT
      },
      [rows, compact],
    ),
    getItemKey: useCallback((index: number) => rows[index]?.key ?? index, [rows]),
  })

  return (
    /* The frame is a wrapper rather than the list itself: the list carries an
       inline pixel height, and a border on that same element would be counted
       inside it — clipping the last row's descenders against the bottom edge. */
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <VirtualList
        virtualizer={virtualizer}
        listRef={listRef}
        scrollMargin={scrollMargin}
        // Every row kind has a fixed height, so the estimates are exact and
        // measuring each row on mount would only add layout work per scroll.
        measure={false}
      >
        {(index) => {
          const row = rows[index]
          if (!row) return null

          // The hairline lives on the row: absolutely positioned siblings cannot
          // be divided by their container.
          const divider =
            index < rows.length - 1 ? 'border-b border-border' : undefined

          if (row.kind === 'group') {
            return (
              <GroupHeaderRow
                name={row.name}
                count={row.count}
                compact={compact}
                className={divider}
              />
            )
          }

          if (row.kind === 'fold') {
            return (
              <FoldRow
                open={openFolds.has(row.key)}
                label={`${row.count} read chapters`}
                detail={row.range}
                // Pinned to FOLD_ROW_HEIGHT: rows are unmeasured, see above.
                className={cn(compact ? 'h-8.5 py-0' : 'h-10.5 py-0', divider)}
                onToggle={() => toggleFold(row.key)}
              />
            )
          }

          if (row.kind === 'divider') {
            return <ResumeDivider compact={compact} className={divider} />
          }

          // One column is the common case and stays a plain row; beyond that the
          // chapters share the line, each keeping its own hairline to the right.
          if (columns === 1) return renderRow(row.chapters[0]!, divider)

          return (
            <div
              className={cn('grid', divider)}
              style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
            >
              {row.chapters.map((chapter, column) => (
                <Fragment key={chapter.url}>
                  {renderRow(
                    chapter,
                    column < row.chapters.length - 1
                      ? 'border-r border-border'
                      : undefined,
                  )}
                </Fragment>
              ))}
            </div>
          )
        }}
      </VirtualList>
    </div>
  )
}

/**
 * The label above one group's chapters.
 *
 * A well rather than a card: these are sibling sections of one list, and the
 * recessed strip separates them without implying each is its own object.
 */
const GroupHeaderRow = memo(function GroupHeaderRow({
  name,
  count,
  compact,
  className,
}: {
  name: string
  count: number
  compact: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        // Pinned to GROUP_ROW_HEIGHT: rows are unmeasured, see above.
        'flex items-center gap-2 bg-muted/50 px-3 text-sm sm:text-xs',
        compact ? 'h-7.5 text-xs' : 'h-9',
        className,
      )}
    >
      <h3 className="min-w-0 flex-1 truncate font-medium text-muted-foreground">
        {name}
      </h3>
      <span className="shrink-0 text-muted-foreground tabular-nums">
        {count}
      </span>
    </div>
  )
})

/** The line between the backlog and what comes next. */
const ResumeDivider = memo(function ResumeDivider({
  compact,
  className,
}: {
  compact: boolean
  className?: string
}) {
  return (
    <div
      role="separator"
      aria-label="Start of unread chapters"
      className={cn(
        // Pinned to DIVIDER_ROW_HEIGHT: rows are unmeasured, see above.
        'flex items-center gap-2.5 bg-primary/8 text-xs font-medium text-primary',
        compact ? 'h-6 px-2.5' : 'h-7.5 px-3.5',
        className,
      )}
    >
      <span>Continue from here</span>
      <span className="h-px flex-1 bg-primary/25" />
    </div>
  )
})

/**
 * How long the pointer has to rest on a chapter before it is prefetched.
 * Long enough that rows streaming under a wheel-scroll never qualify, short
 * enough that a hover on the way to a click still wins the race with it.
 */
const PREFETCH_REST_MS = 150

/**
 * One chapter.
 *
 * Memoized, and deliberately so: the virtualizer re-renders the list on every
 * scroll frame, and a row is an expensive subtree — a router link, a mutation,
 * and three or four buttons. Redrawing every visible row per frame is what made
 * a long list stutter. Its callbacks take the chapter as an argument so the
 * parent can keep them stable.
 */
const ChapterRow = memo(function ChapterRow({
  source,
  slug,
  manga,
  chapter,
  row,
  queueItem,
  busy,
  canMarkPrevious,
  compact,
  className,
  onToggleRead,
  onMarkPrevious,
  onQueued,
}: {
  source: Source
  slug: string
  manga: SManga
  chapter: SChapter
  /** The stored row, absent until this browser has recorded the chapter. */
  row: Chapter | undefined
  /** This chapter's download queue row, in any state, when it has one. */
  queueItem: QueueItem | undefined
  busy: boolean
  canMarkPrevious: boolean
  /** The reader's "compact list view": a shorter row, and up to three a line. */
  compact: boolean
  /** The list's own hairline, carried by the row rather than a wrapper. */
  className?: string
  onToggleRead(chapter: SChapter, read: boolean): void
  onMarkPrevious(chapter: SChapter): void
  /** Fired once a download for this chapter has actually joined the queue. */
  onQueued(): void
}) {
  const ready = useDatabaseReady()
  const queryClient = useQueryClient()
  const read = row?.read ?? false
  const saved = row?.savedAt != null

  /**
   * Start fetching the chapter once the pointer has *rested* on it.
   *
   * The reader asks for this under the same key, so by the time it mounts the
   * content is usually already there. Repeats are free — `staleTime` on the
   * client keeps a warm chapter from being requested twice.
   *
   * Rested, not touched: firing on every enter meant a wheel-scroll streamed
   * rows under the cursor and queued a fetch per row, and each one consumed a
   * permit from the source's rate limiter — so the chapter actually tapped
   * waited behind a backlog of chapters merely scrolled past. The short delay
   * costs a deliberate hover nothing and filters out the drive-bys entirely.
   */
  const prefetch = useCallback(() => {
    void queryClient
      .prefetchQuery(
        chapterContentQueryOptions(
          source,
          source.id,
          slug,
          chapterKey(chapter),
        ),
      )
      .catch(() => undefined)
  }, [queryClient, source, slug, chapter])

  const prefetchTimer = useRef<number | null>(null)

  const schedulePrefetch = useCallback(() => {
    if (prefetchTimer.current !== null) return
    prefetchTimer.current = window.setTimeout(() => {
      prefetchTimer.current = null
      prefetch()
    }, PREFETCH_REST_MS)
  }, [prefetch])

  const cancelPrefetch = useCallback(() => {
    if (prefetchTimer.current === null) return
    window.clearTimeout(prefetchTimer.current)
    prefetchTimer.current = null
  }, [])

  // A row that scrolls out of view mid-wait must not fire from the grave.
  useEffect(() => cancelPrefetch, [cancelPrefetch])

  const meta = [
    chapter.scanlator,
    formatDate(chapter.dateUpload),
    progressLabel(row),
  ].filter((value): value is string => Boolean(value))

  return (
    <div
      className={cn(
        // Pinned to CHAPTER_ROW_HEIGHT: rows are unmeasured, see above.
        'flex items-center',
        compact ? 'h-12 px-2.5' : 'h-15 px-3.5',
        // Read chapters recede onto a recessed strip so the eye can skip them.
        read ? 'bg-muted/30 hover:bg-muted/60' : 'hover:bg-secondary',
        className,
      )}
    >
      <div
        className={cn(
          'flex w-full min-w-0 items-center',
          compact ? 'gap-1.5' : 'gap-2 sm:gap-3',
        )}
      >
        {/* No preload on the link and no prefetch on touch: a touch is how a
            scroll begins, so either would turn every flick through the list
            into a network request. */}
        <Link
          to="/reader/$sourceId/$slug/$chapter"
          params={{ sourceId: source.id, slug, chapter: chapterKey(chapter) }}
          className="min-w-0 flex-1"
          preload={false}
          onMouseEnter={schedulePrefetch}
          onMouseLeave={cancelPrefetch}
          onFocus={schedulePrefetch}
          onBlur={cancelPrefetch}
        >
          {/* Read chapters stay legible but stop competing for attention. */}
          <p
            className={cn(
              'truncate',
              compact ? 'text-sm' : 'text-base sm:text-sm',
              read ? 'text-muted-foreground' : 'font-medium',
            )}
          >
            {chapter.name}
          </p>
          {meta.length > 0 && (
            <p
              className={cn(
                'truncate text-xs text-muted-foreground',
                read && 'text-muted-foreground/70',
              )}
            >
              {meta.join(' · ')}
            </p>
          )}
        </Link>

        <div
          className={cn(
            'flex shrink-0 items-center',
            compact ? 'gap-0' : 'gap-0.5 sm:gap-1',
          )}
        >
          {canMarkPrevious && (
            <Button
              variant="ghost"
              size="icon-sm"
              className={compact ? 'size-7' : 'max-sm:size-8'}
              disabled={!ready || busy}
              title="Mark previous chapters as read"
              aria-label="Mark previous chapters as read"
              onClick={() => onMarkPrevious(chapter)}
            >
              <ArrowUpToLine />
            </Button>
          )}

          <Button
            variant={read ? 'secondary' : 'ghost'}
            size="icon-sm"
            className={compact ? 'size-7' : 'max-sm:size-8'}
            disabled={!ready || busy}
            aria-pressed={read}
            title={read ? 'Mark as unread' : 'Mark as read'}
            aria-label={read ? 'Mark as unread' : 'Mark as read'}
            onClick={() => onToggleRead(chapter, !read)}
          >
            <Check className={read ? undefined : 'opacity-40'} />
          </Button>

          {/* Prose has no pages to pack, so a CBZ means nothing for it. */}
          {!isTextSource(source) && (
            <ExportCbzButton source={source} manga={manga} chapter={chapter} />
          )}

          {/* Local content is already on disk, and its `blob:` page URLs cannot
              be stored by the Cache API, so saving it offline is meaningless. */}
          {!source.isLocal && (
            <ChapterDownloadButton
              sourceId={source.id}
              manga={manga}
              chapter={chapter}
              saved={saved}
              item={queueItem}
              onQueued={onQueued}
            />
          )}
        </div>
      </div>
    </div>
  )
})

/**
 * How far into a chapter the reader got, as a percentage. The total is only
 * known for chapters saved offline, since that is the only path that records a
 * page count — without one there is nothing to take a percentage of, so the
 * position falls back to a bare page number.
 */
function progressLabel(row: Chapter | undefined): string | undefined {
  if (!row || row.read || row.lastPageRead <= 0) return undefined
  const percent = readPercent(row.lastPageRead, row.pageCount)
  return percent === null ? `page ${row.lastPageRead + 1}` : `${percent}%`
}

type ChapterRows = Map<string, Chapter>

const NO_ROWS: ChapterRows = new Map()

function useChapterRows(sourceId: string, manga: SManga): ChapterRows {
  const ready = useDatabaseReady()

  const row = useQuery({
    queryKey: dbKeys.manga(sourceId, manga.url),
    queryFn: () => getMangaByUrl(sourceId, manga.url),
    enabled: ready,
    staleTime: 0,
  })

  const mangaId = row.data?.id ?? null

  const stored = useQuery({
    queryKey: dbKeys.chapters(mangaId ?? ''),
    queryFn: () => (mangaId ? listChapters(mangaId) : Promise.resolve([])),
    enabled: ready && mangaId !== null,
    staleTime: 0,
  })

  return useMemo(() => {
    if (!stored.data) return NO_ROWS
    return new Map(stored.data.map((item) => [item.url, item]))
  }, [stored.data])
}

/** The group of the chapter last opened here, or null. */
function useLastReadGroup(sourceId: string, manga: SManga): string | null {
  const ready = useDatabaseReady()

  const row = useQuery({
    queryKey: dbKeys.manga(sourceId, manga.url),
    queryFn: () => getMangaByUrl(sourceId, manga.url),
    enabled: ready,
    staleTime: 0,
  })
  const mangaId = row.data?.id ?? null

  const last = useQuery({
    queryKey: dbKeys.lastReadGroup(mangaId ?? ''),
    queryFn: () => (mangaId ? lastReadScanlator(mangaId) : Promise.resolve(null)),
    enabled: ready && mangaId !== null,
    staleTime: 0,
  })

  return last.data ?? null
}

function triStateMatches(state: ChapterTriState, value: boolean): boolean {
  if (state === 1) return value
  if (state === 2) return !value
  return true
}

function matchesScanlator(chapter: SChapter, selected: string[]): boolean {
  if (selected.length === 0) return true
  return selected.includes(scanlatorKey(chapter.scanlator))
}

/**
 * The groups this series has chapters from, commonest first.
 *
 * Aggregators carry the same series from several groups at once, and which
 * ones is only knowable once the chapters are in hand — there is no catalogue
 * of them worth fetching. Groups that are selected but no longer present are
 * appended with a count of zero so the dialog can still offer them; without
 * that a stale choice would filter the list by a name the dialog never shows.
 */
function collectScanlators(
  chapters: SChapter[],
  selected: string[],
  rows: ChapterRows,
): ScanlatorOption[] {
  const tallies = new Map<string, ScanlatorOption>()
  for (const chapter of chapters) {
    const name = scanlatorKey(chapter.scanlator)
    const tally =
      tallies.get(name) ??
      { name, count: 0, readCount: 0, downloadedCount: 0 }
    const row = rows.get(chapter.url)
    tally.count += 1
    if (row?.read) tally.readCount += 1
    if (row?.savedAt != null) tally.downloadedCount += 1
    tallies.set(name, tally)
  }

  const present = [...tallies.values()].sort(
    (a, b) =>
      // Unattributed chapters sort last however many there are: they are a
      // leftover bucket, not a group anyone is looking for by name.
      Number(a.name === UNGROUPED) - Number(b.name === UNGROUPED) ||
      // A group already being read or downloaded is the one being followed,
      // so it outranks a larger group that has never been opened.
      Number(isGroupStarted(b)) - Number(isGroupStarted(a)) ||
      b.count - a.count ||
      a.name.localeCompare(b.name),
  )

  const absent = selected
    .filter((name) => !tallies.has(name))
    .map((name) => ({ name, count: 0, readCount: 0, downloadedCount: 0 }))

  return [...present, ...absent]
}

function arrangeChapters(
  chapters: SChapter[],
  state: ChapterFilterState,
  rows: ChapterRows,
  search: string,
): SChapter[] {
  const needle = search.trim().toLowerCase()

  const matched = chapters.filter((chapter) => {
    const row = rows.get(chapter.url)
    return (
      matchesSearch(chapter, needle) &&
      matchesScanlator(chapter, state.scanlators) &&
      triStateMatches(state.downloaded, row?.savedAt != null) &&
      triStateMatches(state.unread, !(row?.read ?? false)) &&
      triStateMatches(state.bookmarked, row?.bookmarked ?? false)
    )
  })

  const compare =
    state.sort === 'uploadDate'
      ? (a: SChapter, b: SChapter) => (a.dateUpload ?? 0) - (b.dateUpload ?? 0)
      : (a: SChapter, b: SChapter) => a.chapterNumber - b.chapterNumber

  return matched.sort((a, b) => (state.ascending ? compare(a, b) : compare(b, a)))
}

/**
 * Whether a chapter answers to the typed term, by title or by number.
 *
 * The number is normalised the way `chapterLabel` prints it so that "214"
 * finds a chapter the source reported as `214.0`. A negative number is the
 * convention for "unknown", so those match on title alone.
 */
function matchesSearch(chapter: SChapter, needle: string): boolean {
  if (!needle) return true
  if (chapter.name.toLowerCase().includes(needle)) return true
  if (!Number.isFinite(chapter.chapterNumber) || chapter.chapterNumber < 0) {
    return false
  }
  return String(Number(chapter.chapterNumber.toFixed(2))).includes(needle)
}

type ChapterSegment = {
  kind: 'read' | 'unread'
  chapters: SChapter[]
}

/**
 * One group's slice of the list, or the whole list when nothing is grouped.
 *
 * `name` being null is what says "no header": one group on show is a run of
 * chapters, not a section of a larger thing.
 */
type ChapterGroupBlock = {
  key: string
  name: string | null
  count: number
  segments: ChapterSegment[]
}

/**
 * Splits the arranged list into per-group blocks, each segmented on its own.
 *
 * Segmenting per group rather than once over the whole list is what keeps a
 * read-fold and the resume divider inside the group they describe; a single
 * pass would happily fold across a group boundary and label the run with a
 * range spanning two groups.
 */
function groupSegments(
  chapters: SChapter[],
  rows: ChapterRows,
  foldable: boolean,
  scanlators: ScanlatorOption[],
): ChapterGroupBlock[] {
  const present = new Set(chapters.map((chapter) => scanlatorKey(chapter.scanlator)))
  if (present.size < 2) {
    return [
      {
        key: 'all',
        name: null,
        count: chapters.length,
        segments: segmentChapters(chapters, rows, foldable),
      },
    ]
  }

  const byGroup = new Map<string, SChapter[]>()
  for (const chapter of chapters) {
    const name = scanlatorKey(chapter.scanlator)
    const bucket = byGroup.get(name)
    if (bucket) bucket.push(chapter)
    else byGroup.set(name, [chapter])
  }

  // `scanlators` is already ordered the way the dropdown lists them — followed
  // groups first, then by size — so the two controls agree on group order.
  const ordered = scanlators
    .map((option) => option.name)
    .filter((name) => byGroup.has(name))

  return ordered.map((name) => {
    const groupChapters = byGroup.get(name)!
    return {
      key: `group-${name}`,
      name: name || UNGROUPED_LABEL,
      count: groupChapters.length,
      segments: segmentChapters(groupChapters, rows, foldable),
    }
  })
}

/** Shorter runs of read chapters are not worth folding away. */
const MIN_READ_RUN = 3

/**
 * Splits the list into runs of read and unread chapters, in display order, so
 * a backlog can collapse behind one row while unread chapters stay in view.
 *
 * Read state is often scattered rather than one leading block, hence runs
 * rather than a simple partition: the order the user chose is preserved.
 */
function segmentChapters(
  sorted: SChapter[],
  rows: ChapterRows,
  grouped: boolean,
): ChapterSegment[] {
  if (!grouped) {
    return sorted.length > 0 ? [{ kind: 'unread', chapters: sorted }] : []
  }

  const segments: ChapterSegment[] = []
  let run: SChapter[] = []
  let runRead = false

  function flush() {
    if (run.length === 0) return
    const kind = runRead && run.length >= MIN_READ_RUN ? 'read' : 'unread'
    const previous = segments.at(-1)
    // A stray read chapter stays inline, which means merging it into the
    // unread rows around it instead of opening a second plain segment.
    if (kind === 'unread' && previous?.kind === 'unread') {
      previous.chapters.push(...run)
    } else {
      segments.push({ kind, chapters: run })
    }
    run = []
  }

  for (const chapter of sorted) {
    const read = rows.get(chapter.url)?.read ?? false
    if (run.length > 0 && read !== runRead) flush()
    runRead = read
    run.push(chapter)
  }
  flush()

  return segments
}

interface ResumeBoundary {
  url: string
  side: 'before' | 'after'
}

/**
 * Where the read backlog meets the next chapter to read. The marker is anchored
 * to the first unread chapter on whichever side the read ones sit: above it when
 * the list runs oldest-first, below it when it runs newest-first.
 *
 * Null unless a read chapter is genuinely adjacent, so a series with nothing
 * read — or a filter that removed the read half — draws no marker at all.
 */
function findResumeBoundary(
  sorted: SChapter[],
  rows: ChapterRows,
  firstUnreadUrl: string | null,
): ResumeBoundary | null {
  if (!firstUnreadUrl) return null
  const index = sorted.findIndex((chapter) => chapter.url === firstUnreadUrl)
  if (index < 0) return null

  const isRead = (chapter: SChapter | undefined) =>
    chapter ? (rows.get(chapter.url)?.read ?? false) : false

  if (isRead(sorted[index - 1])) return { url: firstUnreadUrl, side: 'before' }
  if (isRead(sorted[index + 1])) return { url: firstUnreadUrl, side: 'after' }
  return null
}

function chapterRangeLabel(run: SChapter[]): string {
  const first = run[0]
  const last = run[run.length - 1]
  if (!first || !last) return ''
  const start = chapterLabel(first)
  const end = chapterLabel(last)
  return start === end ? start : `${start} – ${end}`
}

/** Sources report an unknown chapter number as a negative, so fall back to the name. */
function chapterLabel(chapter: SChapter): string {
  if (!Number.isFinite(chapter.chapterNumber) || chapter.chapterNumber < 0) {
    return chapter.name
  }
  return `Ch. ${Number(chapter.chapterNumber.toFixed(2))}`
}

interface ResumeTarget {
  chapter: SChapter
  label: string
}

/**
 * Where "continue reading" goes: the chapter left unfinished, else the first
 * unread one, else back to the beginning.
 */
function pickResume(
  ascending: SChapter[],
  rows: ChapterRows,
): ResumeTarget | null {
  if (ascending.length === 0) return null

  const started = ascending.find((chapter) => {
    const row = rows.get(chapter.url)
    return row ? !row.read && row.lastPageRead > 0 : false
  })
  if (started) return { chapter: started, label: 'Continue reading' }

  const unread = ascending.find(
    (chapter) => !(rows.get(chapter.url)?.read ?? false),
  )
  if (!unread) return { chapter: ascending[0]!, label: 'Read again' }

  const anythingRead = [...rows.values()].some((row) => row.read)
  return { chapter: unread, label: anythingRead ? 'Continue reading' : 'Start reading' }
}

/** Read state needs a row to live on, and browsing alone never creates one. */
async function ensureChapterRow(
  sourceId: string,
  manga: SManga,
  chapter: SChapter,
): Promise<Chapter> {
  const mangaRow = await upsertManga(sourceId, manga)
  const [row] = await upsertChapters(mangaRow.id, [chapter])
  if (!row) {
    throw new Error('Could not record this chapter in the library database.')
  }
  return row
}

/** The loaded layout's shape, so nothing jumps when the data lands. */
function DetailSkeleton() {
  return (
    <div className="md:grid md:grid-cols-[18rem_1fr] md:items-start md:gap-8">
      <div className="flex flex-col gap-4">
        <div className="flex gap-4 md:flex-col md:gap-3">
          <Skeleton className="aspect-[2/3] w-28 shrink-0 rounded-lg sm:w-32 md:w-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-7 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        </div>
        <div className="flex gap-1">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-12 flex-1 rounded-lg" />
          ))}
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-4 max-md:mt-4">
        <Skeleton className="h-16 w-full" />
        <div className="flex gap-1.5">
          <Skeleton className="h-6 w-16 rounded-4xl" />
          <Skeleton className="h-6 w-20 rounded-4xl" />
          <Skeleton className="h-6 w-14 rounded-4xl" />
        </div>
        <div className="flex flex-col gap-2">
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  )
}

/** Mirrors `chapterKeyOf` in the reader: the route param is the url's last segment. */
function chapterKey(chapter: SChapter): string {
  return chapter.url.split('/').pop() ?? String(chapter.chapterNumber)
}

function tryGetSource(id: string): Source | null {
  try {
    return getSource(id)
  } catch {
    return null
  }
}

/** Built once: a chapter row calls this on every render, and there are many. */
const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

function formatDate(timestamp?: number): string | undefined {
  if (!timestamp || Number.isNaN(timestamp)) return undefined
  return DATE_FORMAT.format(new Date(timestamp))
}
