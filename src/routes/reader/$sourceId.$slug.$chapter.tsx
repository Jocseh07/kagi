import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { ChapterDownloadButton } from '@/components/download/chapter-download-button'
import { useQueueItemsByChapterUrl } from '@/components/download/queue-actions'
import { ChapterPicker } from '@/components/reader/chapter-picker'
import { ContinuousViewer } from '@/components/reader/continuous-viewer'
import type { ContinuousViewerHandle } from '@/components/reader/continuous-viewer'
import { PageScrubber } from '@/components/reader/page-scrubber'
import { PagedViewer } from '@/components/reader/paged-viewer'
import { ReaderIdleVeil } from '@/components/reader/reader-idle-veil'
import {
  isPagedMode,
  isRightToLeft,
  readerSurfaceStyle,
  useIdleDim,
  useReaderMode,
  useReaderSurface,
  useResumeBehavior,
  useTextReaderSettings,
  useWordStarts,
} from '@/lib/reader/reader-settings'
import { ReaderSettingsSheet } from '@/components/reader/reader-settings-sheet'
import { ReaderToolbar } from '@/components/reader/reader-toolbar'
import { ResumeNotice } from '@/components/reader/resume-notice'
import { TextViewer } from '@/components/reader/text-viewer'
import type { TextViewerHandle } from '@/components/reader/text-viewer'
import { ErrorPanel, Spinner, ToolbarButton } from '@/components/reader/ui'
import { Progress } from '@/components/ui/progress'
import { useImagePreload, warmImages } from '@/components/reader/use-image-preload'
import { useIdleDimScreen } from '@/components/reader/use-idle-dim'
import { useReaderChrome } from '@/components/reader/use-reader-chrome'
import { useReadingProgress } from '@/components/reader/use-reading-progress'
import { useSpotSaver } from '@/components/reader/use-spot-saver'
import { useStandalone } from '@/lib/pwa/installed'
import { requestSync } from '@/lib/sync/sync-request'
import {
  UNGROUPED_LABEL,
  scanlatorKey,
} from '@/lib/chapters/filter-state'
import { readerScope } from '@/lib/chapters/scope'
import { useChapterFilters } from '@/lib/chapters/use-chapter-filters'
import { recordChapterOpened } from '@/lib/db/history'
import { useDatabase } from '@/lib/db/provider'
import { dbKeys } from '@/lib/db/query-keys'
import {
  getMangaByUrl,
  setChapterPageCount,
  upsertChapters,
  upsertManga,
} from '@/lib/db/repositories'
import type { Chapter } from '@/lib/db/schema'
import { useIncognito } from '@/lib/incognito/store'
import { applyThemeColor, overrideThemeColor } from '@/lib/theme/apply'
import { resolvedMode } from '@/lib/theme/mode'
import { deleteSavedAfterRead } from '@/lib/offline/delete-after-read'
import { getSource } from '@/lib/sources/registry'
import { isTextSource } from '@/lib/sources/types'
import type { Page, SChapter, SManga } from '@/lib/sources/types'
import { chapterKeyOf } from '@/lib/reader/chapter-key'
import { readPageSpot, savePageOffset } from '@/lib/reader/page-offset'
import { spotIsNewer } from '@/lib/reader/page-offset-model'
import {
  chapterContentQueryOptions,
  chapterStubOf,
  findStoredChapter,
  mangaStubOf,
  pagesQueryOptions,
  storedChapterStateQueryOptions,
  storedUpdateQueryOptions,
  textQueryOptions,
} from '@/lib/reader/chapter-queries'
import {
  NOVEL_PROGRESS_SCALE,
  permilleToPercent,
} from '@/lib/text/progress'
import { describeError } from '@/lib/ui/describe-error'

export const Route = createFileRoute('/reader/$sourceId/$slug/$chapter')({
  component: ReaderRoute,
})

const EDITABLE_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'])

/**
 * How far into a chapter the next one is fetched.
 *
 * One threshold covers both readers: `pageCount` is the real page count for a
 * comic and the fixed permille scale for a novel, so the same comparison means
 * "70% of the way through" either way.
 */
const NEXT_CHAPTER_PREFETCH_AT = 0.7

/** Page images of the next chapter warmed alongside its page list. */
const NEXT_CHAPTER_WARM_PAGES = 2

/**
 * How far into a chapter moving on counts as having read it.
 *
 * Reaching the last page marks a chapter read on its own. This covers the
 * other way a chapter ends: you get most of the way through and take the next
 * one. Below the mark the chapter is left alone, so backing out of something
 * you did not want to read does not claim you read it.
 *
 * The same number as the prefetch threshold above, kept separate because it
 * answers a different question and the two should be free to move apart.
 */
const MARK_READ_AT = 0.7

/**
 * How far apart, in permille, a novel's saved paragraph spot and its stored
 * position may be and still describe the same place. The stored position moves
 * in whole-percent steps while scrolling, so it trails the exact one by under
 * ten.
 */
const NOVEL_SPOT_TOLERANCE = 15

/**
 * Longest the chapter stays hidden waiting for the database to open, so a boot
 * that never finishes cannot hold the reader blank.
 */
const RESUME_WAIT_MS = 4000

/** The part of a stored chapter row the reader actually reads. */
function progressOf(row: Chapter) {
  return {
    id: row.id,
    lastPageRead: row.lastPageRead,
    read: row.read,
    pageCount: row.pageCount,
    updatedAt: row.updatedAt,
  }
}

function ReaderRoute() {
  const { sourceId, slug, chapter } = Route.useParams()
  const navigate = useNavigate()
  const router = useRouter()
  const queryClient = useQueryClient()
  const database = useDatabase()
  const databaseReady = database.status === 'ready'
  const databaseFailed = database.status === 'error'
  const [incognito] = useIncognito()

  const [mode] = useReaderMode()
  const [resumeBehavior] = useResumeBehavior()
  const [textSettings] = useTextReaderSettings()
  const [wordStarts, updateWordStarts] = useWordStarts()
  const [dimIdle] = useIdleDim()
  const [surface] = useReaderSurface()
  const surfaceSkin = readerSurfaceStyle(surface)
  const standalone = useStandalone()
  const { dimmed } = useIdleDimScreen(dimIdle && standalone)
  /**
   * Position in the chapter. A page index for a comic, and a permille scroll
   * position for a novel — see `lib/text/progress`. One piece of state rather
   * than two: only one kind is ever mounted, and the resume and progress paths
   * below are shared between them.
   */
  const [currentIndex, setCurrentIndex] = useState(0)
  /**
   * The resume notice, tagged with the chapter it describes.
   *
   * Tagged rather than a bare position so a reset left over from the chapter
   * being changed cannot clear a notice that has just been raised for the new
   * one — the tag decides whether it is shown, not the order the effects ran.
   */
  const [resumeNotice, setResumeNotice] = useState<{
    chapter: string
    at: number
  } | null>(null)
  const [resumeApplied, setResumeApplied] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<ContinuousViewerHandle>(null)
  const textViewerRef = useRef<TextViewerHandle>(null)
  // Mirrors `currentIndex` for the effects that must not re-run per page turn.
  const currentIndexRef = useRef(0)
  const resumedChapter = useRef<string | null>(null)
  /** The open chapter, for handlers that must not change identity with it. */
  const chapterRef = useRef(chapter)
  useLayoutEffect(() => {
    chapterRef.current = chapter
  }, [chapter])
  /** Paged past the last page, onto the end-of-chapter panel. */
  const [pagedEnd, setPagedEnd] = useState(false)
  const [seenChapter, setSeenChapter] = useState(chapter)
  // Adjusted during render so the chapter, its page and the resume flag all
  // change in one commit: progress is never saved against a mixed pair.
  if (seenChapter !== chapter) {
    setSeenChapter(chapter)
    setPagedEnd(false)
    setCurrentIndex(0)
    setResumeApplied(false)
  }

  const source = useMemo(() => {
    try {
      return getSource(sourceId)
    } catch {
      return null
    }
  }, [sourceId])

  const manga = useMemo<SManga>(() => mangaStubOf(slug), [slug])

  // The series page's own choice, read back rather than duplicated: which
  // group a series is followed from is one decision, made there.
  const { filters } = useChapterFilters(sourceId, manga.url)

  const chapterStub = useMemo<SChapter>(
    () => chapterStubOf(slug, chapter),
    [slug, chapter],
  )

  /**
   * This source narrowed to one that serves prose, or null for a comic source.
   * Decides which of the two readers mounts, and carries the narrowing so the
   * text query can call `getChapterText` without a cast.
   */
  const textSource = useMemo(
    () => (source && isTextSource(source) ? source : null),
    [source],
  )
  const isNovel = textSource !== null
  // Novels always scroll, whatever the comic reading mode is set to.
  const paged = !isNovel && isPagedMode(mode)
  const rightToLeft = isRightToLeft(mode)
  /** Comics in Continuous mode. */
  const stripMode = !isNovel && !paged

  const pagesQuery = useQuery({
    ...pagesQueryOptions(source, sourceId, slug, chapter),
    enabled: Boolean(source) && !isNovel,
  })

  const textQuery = useQuery({
    ...textQueryOptions(textSource, sourceId, slug, chapter),
    enabled: Boolean(source) && isNovel,
  })

  /** The query actually driving this reader, so the states below read once. */
  const contentQuery = isNovel ? textQuery : pagesQuery

  // Past ten seconds a bare spinner reads as stuck, so the wait names its cause.
  const [slowChapter, setSlowChapter] = useState<string | null>(null)
  const loading = contentQuery.isPending
  const slow = loading && slowChapter === chapter
  useEffect(() => {
    if (!loading) return
    const timer = window.setTimeout(() => setSlowChapter(chapter), 10_000)
    return () => window.clearTimeout(timer)
  }, [loading, chapter])

  // Chapter navigation is a separate query on purpose: if it fails the chapter
  // still reads, it just loses prev/next and the picker. It shares the series
  // page's key rather than owning one: it is the same request, and arriving
  // here from the series page should find it already fetched.
  const detailsQuery = useQuery({
    queryKey: ['manga', sourceId, slug],
    queryFn: () =>
      source!.getMangaUpdate(manga, {
        fetchDetails: true,
        fetchChapters: true,
      }),
    enabled: Boolean(source),
  })

  /**
   * The chapter list as this device already holds it.
   *
   * A saved chapter opens with no network at all, and without this the reader
   * it opens into has no idea what comes next: the picker is empty and both
   * chapter arrows are dead. The list was written when the series was added
   * and is kept current by the library update, so it is there to be read.
   */
  const storedQuery = useQuery({
    ...storedUpdateQueryOptions(sourceId, slug),
    enabled: databaseReady,
    staleTime: 0,
  })

  /** The fetched chapter list, or the stored one until it arrives. */
  const details = detailsQuery.data ?? storedQuery.data ?? null

  /** This chapter as the source lists it, once the chapter list has arrived. */
  const listedChapter = useMemo(
    () => details?.chapters.find((item) => chapterKeyOf(item) === chapter) ?? null,
    [details, chapter],
  )

  /** Read state of the series' stored chapters, for the chapter list's marks. */
  const chapterStatesQuery = useQuery({
    ...storedChapterStateQueryOptions(sourceId, slug),
    enabled: databaseReady,
    staleTime: 0,
  })

  /**
   * Whether this chapter is saved on the device. Under the `chapterSaved` key,
   * which the save button and the delete-after-read sweep both invalidate.
   */
  const savedQuery = useQuery({
    queryKey: dbKeys.chapterSaved(sourceId, slug, chapter),
    queryFn: async () =>
      (await findStoredChapter(sourceId, manga.url, chapter))?.savedAt != null,
    enabled: databaseReady,
    staleTime: 0,
  })
  const queueItems = useQueueItemsByChapterUrl(sourceId)

  /**
   * The offline save needs a chapter row to hang the page list on, and the
   * reader can be opened on a chapter this browser has never stored, so the
   * row is created on demand.
   */
  const resolveChapterRow = useCallback(async (): Promise<Chapter> => {
    // The stub built from the route params has the slug as its title; writing
    // that over a real title would be a downgrade, so it is only used when the
    // series is genuinely unknown here.
    const existing = details ? null : await getMangaByUrl(sourceId, manga.url)
    const mangaRow = existing ?? (await upsertManga(sourceId, details?.manga ?? manga))

    const [row] = await upsertChapters(mangaRow.id, [listedChapter ?? chapterStub])
    if (!row) {
      throw new Error('Could not record this chapter in the library database.')
    }
    return row
  }, [details, listedChapter, manga, chapterStub, sourceId])

  /**
   * The chapter's stored row id and resume point, read straight off the device.
   *
   * Local only, and deliberately not waiting on anything from the network: the
   * reader holds the chapter hidden until the resume point has been applied,
   * so anything this waits for is time spent looking at a blank reader.
   *
   * `null` means this browser has never recorded the chapter — there is no
   * position to restore, and the row is created below instead.
   */
  const progressQuery = useQuery({
    queryKey: dbKeys.chapterProgress(sourceId, slug, chapter),
    queryFn: async () => {
      const row = await findStoredChapter(sourceId, manga.url, chapter)
      return row ? progressOf(row) : null
    },
    enabled: databaseReady,
    // The resume point is read once per opening; later page turns are this
    // component's own state, and a refetch would fight them.
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  })

  /**
   * The row for a chapter that had none, created on demand.
   *
   * The offline save needs something to hang a page list on and the history
   * entry needs a chapter id, so an unrecorded chapter still gets a row — just
   * not on the reader's critical path. This one does wait for the chapter list
   * to settle: creating the series earlier would record it under the slug from
   * the route rather than its real title.
   */
  const createRowQuery = useQuery({
    queryKey: [...dbKeys.chapterProgress(sourceId, slug, chapter), 'create'],
    queryFn: async () => progressOf(await resolveChapterRow()),
    enabled:
      databaseReady &&
      !detailsQuery.isPending &&
      !storedQuery.isPending &&
      progressQuery.isSuccess &&
      progressQuery.data === null,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  })

  const pages = pagesQuery.data
  const text = textQuery.data

  /**
   * Denominator for the resume point and the progress readout.
   *
   * A comic counts pages. A novel has none, so it uses the fixed permille
   * scale, which is what lets `useReadingProgress` — including its
   * mark-read-at-the-end rule — work unchanged for both.
   */
  const pageCount = isNovel
    ? text
      ? NOVEL_PROGRESS_SCALE
      : 0
    : (pages?.length ?? 0)

  const pageUrls = useMemo(
    () => (pages ?? []).map((page) => page.imageUrl),
    [pages],
  )
  useImagePreload(pageUrls, currentIndex)

  /**
   * The chapters this reader moves between: the open chapter's group, unless
   * the series is being read across all of them.
   *
   * Without this, "Next chapter" on an aggregator hands over the next number
   * from whichever group happens to sort next — a different translation of a
   * chapter you may have already read.
   */
  const ascending = useMemo(
    () =>
      readerScope(
        details?.chapters ?? [],
        listedChapter,
        filters.scanlators,
      ).sort((a, b) => a.chapterNumber - b.chapterNumber),
    [details, listedChapter, filters.scanlators],
  )

  /**
   * The group named on the picker, when naming it tells the reader something:
   * a series with one group, or one being read across all of them, has no
   * choice on show to explain.
   */
  const groupLabel = useMemo(() => {
    if (filters.scanlators.length === 0) return null
    const groups = new Set(
      (details?.chapters ?? []).map((item) => scanlatorKey(item.scanlator)),
    )
    if (groups.size < 2) return null
    const name = scanlatorKey(listedChapter?.scanlator)
    return name || UNGROUPED_LABEL
  }, [details, listedChapter, filters.scanlators])
  const descending = useMemo(() => [...ascending].reverse(), [ascending])

  // A linear scan with a key derivation per item, on a list that can run to a
  // thousand chapters. It only moves when the chapter does.
  const position = useMemo(
    () => ascending.findIndex((item) => chapterKeyOf(item) === chapter),
    [ascending, chapter],
  )
  const previousChapter = position > 0 ? ascending[position - 1] : undefined
  const nextChapter =
    position >= 0 && position < ascending.length - 1
      ? ascending[position + 1]
      : undefined

  /** Set once the next chapter has been prefetched, so it happens once. */
  const prefetchedFrom = useRef<string | null>(null)

  /**
   * Fetch the next chapter while this one is still being read.
   *
   * Late rather than on open: the sources are rate-limited, and a chapter
   * abandoned early should not have pulled the one after it. By the time the
   * reader reaches the threshold the next chapter is a near certainty, and
   * "Next chapter" lands on something already loaded.
   */
  useEffect(() => {
    if (!source || !nextChapter || pageCount === 0) return
    if (currentIndex < pageCount * NEXT_CHAPTER_PREFETCH_AT) return
    if (prefetchedFrom.current === chapter) return
    prefetchedFrom.current = chapter

    const nextKey = chapterKeyOf(nextChapter)
    void queryClient
      .prefetchQuery(
        chapterContentQueryOptions(source, sourceId, slug, nextKey),
      )
      .then(() => {
        const nextPages = queryClient.getQueryData<Page[]>(
          pagesQueryOptions(source, sourceId, slug, nextKey).queryKey,
        )
        if (!nextPages) return
        warmImages(
          nextPages
            .slice(0, NEXT_CHAPTER_WARM_PAGES)
            .map((page) => page.imageUrl),
        )
      })
      // A prefetch that fails costs nothing: the chapter will be fetched again,
      // and reported properly, if it is actually opened.
      .catch(() => undefined)
  }, [
    source,
    nextChapter,
    pageCount,
    currentIndex,
    chapter,
    queryClient,
    sourceId,
    slug,
  ])

  const title = details?.manga.title ?? slug
  const chapterName = ascending[position]?.name ?? `Chapter ${chapter}`

  /**
   * The chapter runs edge to edge, so the browser's own bars are painted out to
   * match it rather than left sitting in the app's surface colour: the status
   * bar and, where the platform follows this, the navigation bar read as part
   * of the page. The colour is read off the reader's own surface, so a muted or
   * light reader does not get a black strip above it. Restored on the way out
   * from whichever theme is actually active, so a theme changed while reading
   * is what comes back.
   *
   * Touch devices only. On a desktop there are no bars pressed against the
   * chapter to blend with — the value would only reach the window frame, where
   * the app's own colour is the right one.
   */
  useEffect(() => {
    if (!globalThis.matchMedia?.('(pointer: coarse)').matches) return

    const root = rootRef.current
    // A resolved colour function, not a hex — the same tolerance
    // `lib/theme/apply` already documents for a theme's authored value.
    const painted = root ? getComputedStyle(root).backgroundColor : ''
    overrideThemeColor(painted || '#000000')
    return () => applyThemeColor(resolvedMode())
  }, [surface])

  /**
   * The scroll element is created by whichever viewer is mounted, so the chrome
   * has to re-attach its listener whenever that changes — which viewer, and
   * whether the chapter has loaded at all, is the whole of it.
   */
  const viewerKey = `${isNovel ? 'text' : paged ? 'paged' : 'strip'}:${contentQuery.isSuccess}:${chapter}`
  const { visible: chromeVisible, onSurfaceTap } = useReaderChrome(
    scrollRef,
    viewerKey,
  )

  /**
   * The chapter has arrived but has not been moved to the stored position yet.
   * Only ever true over the loaded content — a spinner or an error must not be
   * hidden behind a resume.
   */
  const resumePending = contentQuery.isSuccess && !resumeApplied

  // Every chapter shares the single history entry the reader was opened with,
  // so Back always leads out to the series rather than walking back through a
  // long reading session.
  const openChapter = useCallback(
    (target: SChapter) => {
      void navigate({
        to: '/reader/$sourceId/$slug/$chapter',
        params: { sourceId, slug, chapter: chapterKeyOf(target) },
        replace: true,
      })
    },
    [navigate, sourceId, slug],
  )

  const openChapterKey = useCallback(
    (key: string) => {
      void navigate({
        to: '/reader/$sourceId/$slug/$chapter',
        params: { sourceId, slug, chapter: key },
        replace: true,
      })
    },
    [navigate, sourceId, slug],
  )

  const exitToSeries = useCallback(() => {
    // Raw path rather than a typed link: the series route lives outside this
    // feature and may not be in the generated tree yet. Replaced, not pushed,
    // so the reader entry is consumed instead of leaving the reader behind Back.
    router.history.replace(`/manga/${sourceId}/${slug}`)
  }, [router, sourceId, slug])

  const handleIndexChange = useCallback((index: number) => {
    currentIndexRef.current = index
    setCurrentIndex(index)
  }, [])

  /** Moves the reader to a position, in whichever viewer is mounted. */
  const jumpTo = useCallback(
    (index: number, offset = 0) => {
      handleIndexChange(index)
      if (isNovel) {
        textViewerRef.current?.scrollToPermille(index)
        return
      }
      if (paged) return
      viewerRef.current?.scrollTo(index, offset)
    },
    [handleIndexChange, paged, isNovel],
  )

  // Every chapter opens at its top; the resume below moves it from there.
  useEffect(() => {
    currentIndexRef.current = 0
    scrollRef.current?.scrollTo({ top: 0 })
  }, [chapter])

  // Switching viewer relays out every page; hold the reader on the same one.
  useEffect(() => {
    if (currentIndexRef.current > 0) jumpTo(currentIndexRef.current)
  }, [mode, jumpTo])

  const progress = progressQuery.data ?? createRowQuery.data ?? null

  /**
   * Restores the reading position before the chapter is painted.
   *
   * A layout effect rather than a passive one: the content mounts scrolled to
   * the top, and moving it after a paint is the flash this exists to avoid.
   * `renderBody` keeps the chapter laid out but invisible until this has run,
   * which is also what makes the scroll height below measurable.
   */
  useLayoutEffect(() => {
    if (!progress || pageCount === 0) return
    if (resumedChapter.current === chapter) return
    resumedChapter.current = chapter

    if (resumeBehavior === 'restart') {
      setResumeApplied(true)
      return
    }

    // A chapter read to the end reopens at the start rather than on its last
    // page, which is where it was left but not where anyone wants to resume.
    const spot = progress.read ? null : readPageSpot(progress.id)
    // The device's own spot outranks the row only when the row's write never
    // landed after it, as when the tab was killed mid-write.
    const stored =
      spot && spotIsNewer(spot, progress.updatedAt)
        ? spot.page
        : progress.lastPageRead
    const target = progress.read ? 0 : Math.max(0, Math.min(stored, pageCount - 1))
    const spotHere =
      spot !== null &&
      (isNovel
        ? Math.abs(spot.page - target) <= NOVEL_SPOT_TOLERANCE
        : spot.page === target)

    let anchored = false
    if (isNovel && spotHere && spot.block !== undefined) {
      anchored = textViewerRef.current?.scrollToAnchor(spot.block, spot.offset) ?? false
      if (anchored) handleIndexChange(target)
    }
    if (!anchored) {
      const offset = stripMode && spotHere ? spot.offset : 0
      if (target > 0 || offset > 0) jumpTo(target, offset)
    }
    if (target > 0 && resumeBehavior === 'notify') {
      setResumeNotice({ chapter, at: target })
    }
    setResumeApplied(true)
  }, [progress, pageCount, chapter, jumpTo, resumeBehavior, stripMode, isNovel, handleIndexChange])

  /**
   * There is no position to wait for when the database failed to open or the
   * lookup failed, and the chapter must not stay hidden behind a resume that
   * is never coming. A database still opening is waited for: the chapter text
   * often arrives first, and giving up then opens it at the top.
   */
  useEffect(() => {
    if (resumeApplied) return
    const giveUp = () => {
      resumedChapter.current = chapter
      setResumeApplied(true)
    }
    const nothingStored = progressQuery.isSuccess && progressQuery.data === null
    if (databaseFailed || progressQuery.isError || nothingStored) {
      giveUp()
      return
    }
    if (databaseReady) return
    const timer = window.setTimeout(giveUp, RESUME_WAIT_MS)
    return () => window.clearTimeout(timer)
  }, [
    resumeApplied,
    databaseReady,
    databaseFailed,
    progressQuery.isError,
    progressQuery.isSuccess,
    progressQuery.data,
    chapter,
  ])

  /**
   * How long the chapter is, recorded the first time it is opened.
   *
   * Saving offline is otherwise the only thing that writes this, so reading
   * progress elsewhere could only say "page 13" where it means "13 / 40". The
   * stored value is compared first, so reopening a chapter writes nothing.
   */
  useEffect(() => {
    if (!databaseReady || incognito || !progress || pageCount === 0) return
    if (progress.pageCount === pageCount) return
    void setChapterPageCount(progress.id, pageCount).catch(() => undefined)
  }, [databaseReady, incognito, progress, pageCount])

  /** The chapter whose opening has already been recorded, so it happens once. */
  const recordedChapter = useRef<string | null>(null)

  /**
   * Puts the chapter in the history the moment it opens, rather than waiting
   * for it to be finished.
   *
   * Someone trying a series by its prologue has read it whether or not they
   * reach the last page, and whether or not the series is in their library —
   * the entry is what leads them back to it. Moving on to the next
   * chapter re-resolves `progress`, so each chapter entered records its own.
   */
  useEffect(() => {
    if (!databaseReady || incognito || !progress) return
    if (recordedChapter.current === progress.id) return
    recordedChapter.current = progress.id

    void recordChapterOpened(progress.id).then(
      () => {
        void queryClient.invalidateQueries({ queryKey: dbKeys.history })
        void queryClient.invalidateQueries({ queryKey: dbKeys.library })
      },
      () => {
        // Let a later render try again rather than losing the entry outright.
        recordedChapter.current = null
      },
    )
  }, [databaseReady, incognito, progress, queryClient])

  /** Chapters read since the open chapter last changed, acted on when it does. */
  const readChapterIds = useRef(new Set<string>())

  const onChapterRead = useCallback(
    (id: string) => {
      readChapterIds.current.add(id)
      void queryClient.invalidateQueries({ queryKey: dbKeys.history })
      void queryClient.invalidateQueries({ queryKey: dbKeys.allChapters })
      void queryClient.invalidateQueries({ queryKey: dbKeys.library })
      // A finished chapter is the one fact worth sending at once; the request is
      // rate-limited and a no-op on a build or session that cannot sync.
      requestSync('chapter-read')
    },
    [queryClient],
  )

  /**
   * Frees read chapters' downloads, if that is switched on.
   *
   * Deliberately on the way out, when another chapter opens or the reader
   * closes, rather than the moment the last page lands: a read chapter can
   * still be scrolled back through, and deleting its pages would blank it offline.
   */
  useEffect(() => {
    const read = readChapterIds.current
    return () => {
      const ids = [...read]
      read.clear()
      if (ids.length === 0) return
      void deleteSavedAfterRead(ids).then(() => {
        void queryClient.invalidateQueries({
          queryKey: dbKeys.chapterSavedIn(sourceId, slug),
        })
        void queryClient.invalidateQueries({ queryKey: dbKeys.savedChapters })
        void queryClient.invalidateQueries({ queryKey: dbKeys.storage })
        void queryClient.invalidateQueries({ queryKey: dbKeys.allChapters })
      })
    }
  }, [queryClient, sourceId, slug, chapter])

  const { markReadNow, saveNow } = useReadingProgress({
    chapterId: progress?.id ?? null,
    pageIndex: currentIndex,
    pageCount,
    // Writing before the resume point has been applied would overwrite it.
    // Incognito stops the recording, not the reading: the stored resume point
    // is still read and applied above, it just stops moving from here on.
    enabled: databaseReady && resumeApplied && !incognito,
    onChapterRead,
  })

  // Read by `advanceChapter` below, which has to keep its identity across page
  // turns: it is handed to the end-of-chapter block, and a new function every
  // page would defeat the memoisation the strip depends on. Written from an
  // effect, so nothing reads a ref mid-render; effects for a commit have all
  // run before a click in it can reach the handler.
  const advanceState = useRef({ pageCount, nextChapter })
  useEffect(() => {
    advanceState.current = { pageCount, nextChapter }
  }, [pageCount, nextChapter])

  // Tagged with its chapter so a spot is never stored against another
  // chapter's row while the two are changing over.
  const spotState = useRef({
    id: progress?.id ?? null,
    chapter,
    on: false,
    kind: 'paged' as 'text' | 'strip' | 'paged',
  })
  useEffect(() => {
    spotState.current = {
      id: progress?.id ?? null,
      chapter,
      on: databaseReady && resumeApplied && !incognito,
      kind: isNovel ? 'text' : stripMode ? 'strip' : 'paged',
    }
  }, [progress, chapter, databaseReady, resumeApplied, incognito, isNovel, stripMode])

  /**
   * Writes where the reader is: the local spot first, synchronously, then the
   * database. A tab killed in between leaves the newer local spot, which the
   * resume above prefers over the older row.
   */
  const saveSpot = useCallback(() => {
    const { id, chapter: current, on, kind } = spotState.current
    if (!on || !id || current !== chapterRef.current) return
    const at = Date.now()
    if (kind === 'text') {
      const spot = textViewerRef.current?.spot()
      if (!spot) return
      savePageOffset(id, spot.permille, spot.offset, { block: spot.block, at })
    } else if (kind === 'strip') {
      const spot = viewerRef.current?.position()
      if (!spot) return
      savePageOffset(id, spot.pageIndex, spot.offset, { at })
    } else {
      savePageOffset(id, currentIndexRef.current, 0, { at })
    }
    saveNow()
  }, [saveNow])

  const spotSaver = useSpotSaver(saveSpot)

  // A scroll that never pauses still gets saved, once per heartbeat.
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const onScroll = () => spotSaver.request()
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
  }, [spotSaver, viewerKey])

  // A page turn is a settled position of its own.
  useEffect(() => {
    if (paged && resumeApplied) spotSaver.settle()
  }, [paged, resumeApplied, currentIndex, pagedEnd, spotSaver])

  /**
   * Moving on to the next chapter: the bar's arrow, Shift+→, and the button at
   * the end of the page.
   *
   * Far enough in, this is how a chapter ends, so it is recorded as read here
   * rather than only on the last page. The chapter picker deliberately does
   * not come through here — jumping to a chapter by name is navigation, not
   * finishing what you were reading.
   */
  const advanceChapter = useCallback(() => {
    const { pageCount: total, nextChapter: target } = advanceState.current
    if (!target) return
    if (total > 0 && currentIndexRef.current >= total * MARK_READ_AT) {
      markReadNow()
    }
    openChapter(target)
  }, [markReadNow, openChapter])

  const scrollByViewport = useCallback((direction: 1 | -1) => {
    const container = scrollRef.current
    if (!container) return
    container.scrollBy({
      top: direction * container.clientHeight * 0.9,
      behavior: 'smooth',
    })
  }, [])

  const goNext = useCallback(() => {
    if (!paged) {
      scrollByViewport(1)
      return
    }
    if (pagedEnd) return
    if (currentIndex < pageCount - 1) {
      handleIndexChange(currentIndex + 1)
      return
    }
    // The chapter ends on its own panel; moving on is the panel's button.
    if (pageCount > 0) setPagedEnd(true)
  }, [
    paged,
    pagedEnd,
    scrollByViewport,
    currentIndex,
    pageCount,
    handleIndexChange,
  ])

  const goPrevious = useCallback(() => {
    if (!paged) {
      scrollByViewport(-1)
      return
    }
    if (pagedEnd) {
      setPagedEnd(false)
      return
    }
    if (currentIndex > 0) handleIndexChange(currentIndex - 1)
  }, [
    paged,
    pagedEnd,
    scrollByViewport,
    currentIndex,
    handleIndexChange,
  ])

  // Paged, the page on screen is this state alone; the mirror follows it.
  useEffect(() => {
    if (paged) currentIndexRef.current = currentIndex
  }, [paged, currentIndex])

  const goNextChapter = advanceChapter

  const goPreviousChapter = useCallback(() => {
    if (previousChapter) openChapter(previousChapter)
  }, [previousChapter, openChapter])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || EDITABLE_TAGS.has(target.tagName))
      ) {
        return
      }

      switch (event.key) {
        case 'Escape':
          exitToSeries()
          break
        case ' ':
          event.preventDefault()
          if (event.shiftKey) goPrevious()
          else goNext()
          break
        case 'ArrowDown':
        case 'PageDown':
          event.preventDefault()
          goNext()
          break
        case 'ArrowUp':
        case 'PageUp':
          event.preventDefault()
          goPrevious()
          break
        case 'b':
        case 'B':
          if (!isNovel || event.metaKey || event.ctrlKey || event.altKey) break
          updateWordStarts({ enabled: !wordStarts.enabled })
          break
        // Shift is handled inside the case rather than as a case of its own:
        // the plain arrows would otherwise swallow it and turn a page.
        case 'ArrowRight':
          event.preventDefault()
          if (event.shiftKey) {
            if (rightToLeft) goPreviousChapter()
            else goNextChapter()
          } else if (rightToLeft) goPrevious()
          else goNext()
          break
        case 'ArrowLeft':
          event.preventDefault()
          if (event.shiftKey) {
            if (rightToLeft) goNextChapter()
            else goPreviousChapter()
          } else if (rightToLeft) goNext()
          else goPrevious()
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    exitToSeries,
    goNext,
    goPrevious,
    goNextChapter,
    goPreviousChapter,
    rightToLeft,
    isNovel,
    wordStarts.enabled,
    updateWordStarts,
  ])

  // Handed to the viewer as `footer`. Rebuilding it every render would change
  // that prop's identity on every page turn, which is exactly what the pages
  // below are memoised to avoid.
  const endOfChapter = useMemo(
    () => (
      <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
        <p className="text-sm text-muted-foreground">End of {chapterName}</p>
        <div className="flex flex-wrap justify-center gap-2">
          {previousChapter ? (
            <ToolbarButton
              variant="solid"
              onClick={() => openChapter(previousChapter)}
            >
              Previous chapter
            </ToolbarButton>
          ) : null}
          {nextChapter ? (
            <ToolbarButton variant="accent" onClick={advanceChapter}>
              Next chapter
            </ToolbarButton>
          ) : (
            <ToolbarButton variant="solid" onClick={exitToSeries}>
              Back to series
            </ToolbarButton>
          )}
        </div>
      </div>
    ),
    [chapterName, previousChapter, nextChapter, openChapter, advanceChapter, exitToSeries],
  )

  return (
    // The palette is forced dark for every background except "Follow the app":
    // `dark` here re-scopes it for everything inside, so every shared token
    // below resolves to the chosen theme's own dark values. The background
    // itself arrives as a `--background` override, so `bg-background` stays the
    // class and every descendant reading that token follows.
    <div
      ref={rootRef}
      className={`${surfaceSkin.className} fixed inset-0 z-50 bg-background text-foreground`}
      style={surfaceSkin.style}
    >
      {dimIdle && standalone ? <ReaderIdleVeil dimmed={dimmed} /> : null}
      {/* Over the page, not above it: hiding it then costs the chapter no
          reflow, so nothing under it moves while it comes and goes.

          The safe-area padding, and the background carrying up through it, are
          for the platforms that keep a status bar over the page no matter what
          is asked of them: the bar sits below the indicators rather than under
          them, and the strip they occupy reads as part of it. */}
      <div
        aria-hidden={!chromeVisible}
        className={`absolute inset-x-0 top-0 z-20 bg-card/90 pt-[env(safe-area-inset-top)] transition-[transform,opacity] duration-200 motion-reduce:transition-none ${
          chromeVisible
            ? ''
            : 'pointer-events-none -translate-y-full opacity-0'
        }`}
      >
        <ReaderToolbar
          title={title}
          subtitle={
            listedChapter?.scanlator
              ? `${chapterName} · ${listedChapter.scanlator}`
              : chapterName
          }
          progressPercent={progressPercent()}
          onExit={exitToSeries}
          actions={
            // The series page's rule: local files are already on disk, and a
            // locked chapter can only come back locked.
            source && details && listedChapter && !source.isLocal && !listedChapter.locked ? (
              <ChapterDownloadButton
                sourceId={sourceId}
                manga={details.manga}
                chapter={listedChapter}
                saved={savedQuery.data ?? false}
                item={queueItems.get(listedChapter.url)}
                className="size-10 max-sm:size-10"
              />
            ) : null
          }
        />
      </div>

      <div className="relative h-full" onClick={onSurfaceTap}>
        {/* Laid out but not shown until the reading position has been applied:
            the scroll needs a measurable height to aim at, and a chapter that
            paints at the top and then jumps reads as a glitch. `invisible`
            rather than unmounted for exactly that reason. */}
        <div className={`h-full ${resumePending ? 'invisible' : ''}`}>
          {renderBody()}
        </div>

        {/* A hairline of progress while the bars are away, so position is
            never wholly out of sight. */}
        {!chromeVisible && progressPercent() !== null ? (
          <Progress
            value={progressPercent() ?? 0}
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-[env(safe-area-inset-top)] z-20 h-0.5 rounded-none bg-transparent [&>[data-slot=progress-indicator]]:bg-primary/70"
          />
        ) : null}

        {/* Moving through the chapter and between chapters, floating over the
            page rather than in the title bar, and brought up with a tap. The
            column stays click-through so it never eats a page tap; only the
            bar and the notice take input. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-20 flex flex-col items-center gap-2 px-3">
          {/* Held back until the chapter is on screen, so its few seconds are
              spent being read rather than sitting over a blank reader. Keyed by
              chapter so each one gets its own countdown from that moment.
              Stacked above the bar rather than drawn on top of it. */}
          {resumeNotice && resumeNotice.chapter === chapter && !resumePending && (
            <ResumeNotice
              key={chapter}
              position={
                isNovel
                  ? `${permilleToPercent(resumeNotice.at)}%`
                  : `page ${resumeNotice.at + 1}`
              }
              onStartOver={() => {
                jumpTo(0)
                setResumeNotice(null)
              }}
              onDismiss={() => setResumeNotice(null)}
            />
          )}

          <div
            aria-hidden={!chromeVisible}
            className={`w-full max-w-xl transition-[transform,opacity] duration-200 motion-reduce:transition-none ${
              chromeVisible
                ? ''
                : 'translate-y-[calc(100%+1rem+env(safe-area-inset-bottom))] opacity-0'
            }`}
          >
            <div
              className={`rounded-xl border border-border bg-card/95 p-1.5 shadow-xl ${
                chromeVisible ? 'pointer-events-auto' : 'pointer-events-none'
              }`}
            >
              {pageCount > 0 && contentQuery.isSuccess ? (
                <PageScrubber
                  kind={isNovel ? 'percent' : 'pages'}
                  value={isNovel ? permilleToPercent(currentIndex) : currentIndex}
                  total={pageCount}
                  rightToLeft={paged && rightToLeft}
                  onChange={(next) => {
                    setPagedEnd(false)
                    jumpTo(isNovel ? next * 10 : next)
                  }}
                />
              ) : null}

              <div className="flex items-center gap-1.5">
                <ToolbarButton
                  variant="solid"
                  className="size-10 p-0"
                  disabled={!previousChapter}
                  title="Previous chapter (Shift+←)"
                  aria-label="Previous chapter"
                  onClick={() => previousChapter && openChapter(previousChapter)}
                >
                  <ChevronLeft aria-hidden className="size-5" />
                </ToolbarButton>

                <ChapterPicker
                  chapters={descending}
                  currentKey={chapter}
                  groupLabel={groupLabel}
                  states={chapterStatesQuery.data}
                  novel={isNovel}
                  onSelect={openChapterKey}
                />

                <ToolbarButton
                  variant={nextChapter ? 'accent' : 'solid'}
                  className="size-10 p-0"
                  disabled={!nextChapter}
                  title="Next chapter (Shift+→)"
                  aria-label="Next chapter"
                  onClick={advanceChapter}
                >
                  <ChevronRight aria-hidden className="size-5" />
                </ToolbarButton>

                <span aria-hidden className="mx-0.5 h-6 w-px shrink-0 bg-border" />

                <ReaderSettingsSheet novel={isNovel} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )

  /** How far through the chapter, 0–100, for the bars. Null before it loads. */
  function progressPercent(): number | null {
    if (pageCount === 0) return null
    if (isNovel) return permilleToPercent(currentIndex)
    // A comic is done when its last page is on screen, not when it is passed.
    return ((Math.min(currentIndex, pageCount - 1) + 1) / pageCount) * 100
  }

  function renderBody() {
    if (!source) {
      return (
        <Centered>
          <ErrorPanel
            title="Unknown source"
            detail={`No source is registered with the id "${sourceId}".`}
          />
        </Centered>
      )
    }

    if (contentQuery.isPending) {
      return (
        <Centered>
          <div className="flex flex-col items-center gap-2">
            <Spinner label="Loading chapter" />
            {slow ? (
              <p className="text-xs text-muted-foreground">{source.name} is slow to answer.</p>
            ) : null}
          </div>
        </Centered>
      )
    }

    if (contentQuery.isError) {
      return (
        <Centered>
          <ErrorPanel
            title="Could not load this chapter"
            detail={describeError(contentQuery.error)}
          >
            <ToolbarButton
              variant="solid"
              onClick={() => void contentQuery.refetch()}
            >
              Try again
            </ToolbarButton>
            <ToolbarButton onClick={exitToSeries}>Back to series</ToolbarButton>
          </ErrorPanel>
        </Centered>
      )
    }

    if (isNovel) {
      if (!text || !text.html.trim()) {
        return (
          <Centered>
            <ErrorPanel
              title="No text"
              detail="The source returned an empty chapter."
            >
              <ToolbarButton variant="solid" onClick={() => void contentQuery.refetch()}>
                Try again
              </ToolbarButton>
              <ToolbarButton onClick={exitToSeries}>Back to series</ToolbarButton>
            </ErrorPanel>
          </Centered>
        )
      }

      return (
        <TextViewer
          key={chapter}
          ref={textViewerRef}
          html={text.html}
          settings={textSettings}
          wordStarts={wordStarts.enabled ? wordStarts.strength : null}
          scrollRef={scrollRef}
          onPositionChange={handleIndexChange}
          onScrollSettle={spotSaver.settle}
          footer={endOfChapter}
        />
      )
    }

    if (!pages || pages.length === 0) {
      return (
        <Centered>
          <ErrorPanel
            title="No pages"
            detail="The source returned an empty page list for this chapter."
          >
            <ToolbarButton variant="solid" onClick={() => void contentQuery.refetch()}>
              Try again
            </ToolbarButton>
            <ToolbarButton onClick={exitToSeries}>Back to series</ToolbarButton>
          </ErrorPanel>
        </Centered>
      )
    }

    if (paged) {
      return (
        <PagedViewer
          page={pagedEnd ? null : pages[Math.min(currentIndex, pages.length - 1)]}
          end={pagedEnd ? endOfChapter : undefined}
          total={pages.length}
          rightToLeft={rightToLeft}
          onPrevious={goPrevious}
          onNext={goNext}
        />
      )
    }

    return (
      <ContinuousViewer
        key={chapter}
        ref={viewerRef}
        pages={pages}
        scrollRef={scrollRef}
        onPositionChange={handleIndexChange}
        onScrollSettle={spotSaver.settle}
        footer={endOfChapter}
      />
    )
  }
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6">{children}</div>
  )
}


