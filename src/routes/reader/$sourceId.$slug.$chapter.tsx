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

import { ChapterPicker, chapterKeyOf } from '@/components/reader/chapter-picker'
import { ContinuousViewer } from '@/components/reader/continuous-viewer'
import type { ContinuousViewerHandle } from '@/components/reader/continuous-viewer'
import { PagedViewer } from '@/components/reader/paged-viewer'
import { ReaderFullscreen } from '@/components/reader/reader-fullscreen'
import {
  isPagedMode,
  isRightToLeft,
  useFullscreenReader,
  useReaderMode,
  useResumeBehavior,
  useTextReaderSettings,
} from '@/components/reader/reader-settings'
import { ReaderToolbar } from '@/components/reader/reader-toolbar'
import { ResumeNotice } from '@/components/reader/resume-notice'
import { TextViewer } from '@/components/reader/text-viewer'
import type { TextViewerHandle } from '@/components/reader/text-viewer'
import { ErrorPanel, Spinner, ToolbarButton } from '@/components/reader/ui'
import { useImagePreload, warmImages } from '@/components/reader/use-image-preload'
import { useFullscreenScreen } from '@/components/reader/use-fullscreen-reader'
import { useReaderChrome } from '@/components/reader/use-reader-chrome'
import { useReadingProgress } from '@/components/reader/use-reading-progress'
import { requestSync } from '@/lib/sync/sync-events'
import {
  UNGROUPED_LABEL,
  scanlatorKey,
} from '@/lib/chapters/filter-state'
import { readerScope } from '@/lib/chapters/scope'
import { useChapterFilters } from '@/lib/chapters/use-chapter-filters'
import { recordChapterOpened } from '@/lib/db/history'
import { useDatabaseReady } from '@/lib/db/provider'
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
import {
  chapterContentQueryOptions,
  chapterStubOf,
  findStoredChapter,
  mangaStubOf,
  pagesQueryOptions,
  storedUpdateQueryOptions,
  textQueryOptions,
} from '@/lib/reader/chapter-queries'
import {
  NOVEL_PROGRESS_SCALE,
  permilleToPercent,
} from '@/lib/text/progress'

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

/** The part of a stored chapter row the reader actually reads. */
function progressOf(row: Chapter) {
  return {
    id: row.id,
    lastPageRead: row.lastPageRead,
    read: row.read,
    pageCount: row.pageCount,
  }
}

function ReaderRoute() {
  const { sourceId, slug, chapter } = Route.useParams()
  const navigate = useNavigate()
  const router = useRouter()
  const queryClient = useQueryClient()
  const databaseReady = useDatabaseReady()
  const [incognito] = useIncognito()

  const [mode] = useReaderMode()
  const [resumeBehavior] = useResumeBehavior()
  const [textSettings] = useTextReaderSettings()
  const [fullscreen] = useFullscreenReader()
  const { dimmed } = useFullscreenScreen(fullscreen)
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
  const scrollRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<ContinuousViewerHandle>(null)
  const textViewerRef = useRef<TextViewerHandle>(null)
  // Mirrors `currentIndex` for the effects that must not re-run per page turn.
  const currentIndexRef = useRef(0)
  const resumedChapter = useRef<string | null>(null)

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

  const paged = isPagedMode(mode)
  const rightToLeft = isRightToLeft(mode)

  /**
   * The chapter runs edge to edge, so the browser's own bars are painted out to
   * match it rather than left sitting in the app's surface colour: the status
   * bar and, where the platform follows this, the navigation bar read as part
   * of the page. Restored on the way out from whichever theme is actually
   * active, so a theme changed while reading is what comes back.
   *
   * Touch devices only. On a desktop there are no bars pressed against the
   * chapter to blend with — the value would only reach the window frame, where
   * the app's own colour is the right one.
   */
  useEffect(() => {
    if (!globalThis.matchMedia?.('(pointer: coarse)').matches) return

    overrideThemeColor('#000000')
    return () => applyThemeColor(resolvedMode())
  }, [])

  /**
   * The scroll element is created by whichever viewer is mounted, so the chrome
   * has to re-attach its listener whenever that changes — which viewer, and
   * whether the chapter has loaded at all, is the whole of it.
   */
  const { visible: chromeVisible, onSurfaceTap } = useReaderChrome(
    scrollRef,
    `${isNovel ? 'text' : paged ? 'paged' : 'strip'}:${contentQuery.isSuccess}:${chapter}`,
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
    (index: number) => {
      handleIndexChange(index)
      if (isNovel) {
        textViewerRef.current?.scrollToPermille(index)
        return
      }
      if (paged) return
      viewerRef.current?.scrollTo(index)
    },
    [handleIndexChange, paged, isNovel],
  )

  useEffect(() => {
    currentIndexRef.current = 0
    setCurrentIndex(0)
    setResumeApplied(false)
    scrollRef.current?.scrollTo({ top: 0 })
    // The notice is not cleared here: it carries the chapter it belongs to, so
    // a stale one simply stops matching, and a fresh one survives this reset
    // whichever order the two run in.
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
    const target = progress.read
      ? 0
      : Math.min(progress.lastPageRead, pageCount - 1)
    if (target > 0) {
      jumpTo(target)
      if (resumeBehavior === 'notify') setResumeNotice({ chapter, at: target })
    }
    setResumeApplied(true)
  }, [progress, pageCount, chapter, jumpTo, resumeBehavior])

  /**
   * There is no position to wait for when the database is unavailable or the
   * lookup failed, and the chapter must not stay hidden behind a resume that
   * is never coming.
   */
  useEffect(() => {
    if (resumeApplied) return
    const nothingStored = progressQuery.isSuccess && progressQuery.data === null
    if (databaseReady && !progressQuery.isError && !nothingStored) return
    resumedChapter.current = chapter
    setResumeApplied(true)
  }, [
    resumeApplied,
    databaseReady,
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
   * the entry is what leads them back to it. Reading forward into the next
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

  /** Set once this chapter is read, and acted on when the reader leaves it. */
  const readChapterId = useRef<string | null>(null)

  const onChapterRead = useCallback(() => {
    readChapterId.current = progress?.id ?? null
    void queryClient.invalidateQueries({ queryKey: dbKeys.history })
    void queryClient.invalidateQueries({ queryKey: dbKeys.allChapters })
    void queryClient.invalidateQueries({ queryKey: dbKeys.library })
    // A finished chapter is the one fact worth sending at once; the request is
    // rate-limited and a no-op on a build or session that cannot sync.
    requestSync('chapter-read')
  }, [queryClient, progress])

  /**
   * Frees a read chapter's download, if that is switched on.
   *
   * Deliberately on the way out — moving to another chapter or leaving the
   * reader — rather than the moment the last page lands: deleting the pages
   * under an open chapter would blank it on the next reload.
   */
  useEffect(() => {
    return () => {
      const chapterId = readChapterId.current
      readChapterId.current = null
      if (!chapterId) return
      void deleteSavedAfterRead([chapterId]).then(() => {
        void queryClient.invalidateQueries({
          queryKey: dbKeys.chapterSaved(sourceId, slug, chapter),
        })
        void queryClient.invalidateQueries({ queryKey: dbKeys.savedChapters })
        void queryClient.invalidateQueries({ queryKey: dbKeys.storage })
        void queryClient.invalidateQueries({ queryKey: dbKeys.allChapters })
      })
    }
  }, [queryClient, sourceId, slug, chapter])

  const { markReadNow } = useReadingProgress({
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
    if (currentIndex < pageCount - 1) {
      handleIndexChange(currentIndex + 1)
      return
    }
    advanceChapter()
  }, [
    paged,
    scrollByViewport,
    currentIndex,
    pageCount,
    advanceChapter,
    handleIndexChange,
  ])

  const goPrevious = useCallback(() => {
    if (!paged) {
      scrollByViewport(-1)
      return
    }
    if (currentIndex > 0) {
      handleIndexChange(currentIndex - 1)
      return
    }
    if (previousChapter) openChapter(previousChapter)
  }, [
    paged,
    scrollByViewport,
    currentIndex,
    previousChapter,
    openChapter,
    handleIndexChange,
  ])

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
    // The reader is a dark surface regardless of the app theme: `dark` here
    // re-scopes the whole palette for everything inside, so every shared token
    // below resolves to the chosen theme's own dark values.
    <div
      className="dark fixed inset-0 z-50 bg-background text-foreground"
      data-fullscreen={fullscreen || undefined}
    >
      {fullscreen ? <ReaderFullscreen dimmed={dimmed} /> : null}
      {/* Over the page, not above it: hiding it then costs the chapter no
          reflow, so nothing under it moves while it comes and goes.

          The safe-area padding, and the background carrying up through it, are
          for the platforms that keep a status bar over the page no matter what
          is asked of them: the bar sits below the indicators rather than under
          them, and the strip they occupy reads as part of it. */}
      <div
        aria-hidden={!chromeVisible}
        className={`absolute inset-x-0 top-0 z-20 bg-card/90 pt-[env(safe-area-inset-top)] backdrop-blur transition-[transform,opacity] duration-200 in-data-fullscreen:top-[calc(1.5rem+env(safe-area-inset-top))] in-data-fullscreen:pt-0 ${
          chromeVisible
            ? ''
            : 'pointer-events-none -translate-y-full opacity-0'
        }`}
      >
        <ReaderToolbar
          title={title}
          chapterName={chapterName}
          pageIndicator={progressLabel()}
          progressPercent={progressPercent()}
          onExit={exitToSeries}
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

        {/* All three ways to change chapter, floating over the page rather than
            in the toolbar: the moment you want them is the moment you reach the
            bottom. The wrapper stays click-through so it never eats a page tap;
            only the bar itself is interactive. */}
        <div
          aria-hidden={!chromeVisible}
          className={`pointer-events-none absolute inset-x-0 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-20 flex justify-center px-3 transition-[transform,opacity] duration-200 in-data-fullscreen:bottom-[calc(2.5rem+env(safe-area-inset-bottom))] ${
            chromeVisible
              ? ''
              : 'translate-y-[calc(100%+1rem+env(safe-area-inset-bottom))] opacity-0'
          }`}
        >
          <div
            className={`flex max-w-full items-center gap-1.5 rounded-xl border border-border bg-card/95 px-1.5 py-1.5 shadow-xl backdrop-blur ${
              chromeVisible ? 'pointer-events-auto' : 'pointer-events-none'
            }`}
          >
            <ToolbarButton
              variant="solid"
              className="size-8 p-0"
              disabled={!previousChapter}
              title="Previous chapter (Shift+←)"
              aria-label="Previous chapter"
              onClick={() => previousChapter && openChapter(previousChapter)}
            >
              <ChevronLeft aria-hidden className="size-4" />
            </ToolbarButton>

            <ChapterPicker
              chapters={descending}
              currentKey={chapter}
              groupLabel={groupLabel}
              onSelect={openChapterKey}
            />

            <ToolbarButton
              variant={nextChapter ? 'accent' : 'solid'}
              className="size-8 p-0"
              disabled={!nextChapter}
              title="Next chapter (Shift+→)"
              aria-label="Next chapter"
              onClick={advanceChapter}
            >
              <ChevronRight aria-hidden className="size-4" />
            </ToolbarButton>
          </div>
        </div>

        {/* Held back until the chapter is on screen, so its few seconds are
            spent being read rather than sitting over a blank reader. Keyed by
            chapter so each one gets its own countdown from that moment. */}
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
      </div>
    </div>
  )

  /** "33%" for either content kind, an em dash before the chapter loads. */
  function progressLabel(): string {
    const percent = progressPercent()
    if (percent === null) return '—'
    return `${Math.round(percent)}%`
  }

  /** The same position as `progressLabel`, on a 0–100 scale for the bar. */
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
          <Spinner label="Loading chapter" />
        </Centered>
      )
    }

    if (contentQuery.isError) {
      return (
        <Centered>
          <ErrorPanel
            title="Could not load this chapter"
            detail={messageOf(contentQuery.error)}
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
            />
          </Centered>
        )
      }

      return (
        <TextViewer
          ref={textViewerRef}
          html={text.html}
          settings={textSettings}
          scrollRef={scrollRef}
          onPositionChange={handleIndexChange}
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
          />
        </Centered>
      )
    }

    if (paged) {
      return (
        <PagedViewer
          page={pages[Math.min(currentIndex, pages.length - 1)]}
          total={pages.length}
          rightToLeft={rightToLeft}
          onPrevious={goPrevious}
          onNext={goNext}
        />
      )
    }

    return (
      <ContinuousViewer
        ref={viewerRef}
        pages={pages}
        scrollRef={scrollRef}
        onPositionChange={handleIndexChange}
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

