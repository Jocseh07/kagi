import { useCallback, useEffect, useRef } from 'react'

import { markChapterRead, setLastPageRead } from '@/lib/db/repositories'

/**
 * Every write is a round trip to the database worker, so page turns are
 * coalesced: at most one write per interval, always carrying the latest page.
 */
const WRITE_INTERVAL_MS = 1000

interface ReadingProgressOptions {
  /** Null until the chapter has a row to hang progress on. */
  chapterId: string | null
  pageIndex: number
  pageCount: number
  /**
   * False while the database is unavailable, or before the stored resume point
   * has been applied — writing then would overwrite it with page one.
   */
  enabled: boolean
  /** Fired after the chapter is recorded as read, so callers can refresh. */
  onChapterRead?: () => void
}

export interface ReadingProgress {
  /**
   * Records the open chapter as read now, rather than on its last page.
   *
   * For moving on deliberately: the reader calls this when the next chapter is
   * opened from far enough in. Shares the bookkeeping with the automatic mark
   * below, so a chapter cannot be written or announced twice.
   */
  markReadNow(): void
}

/**
 * Persists the reading position of the open chapter, and marks it read once
 * the last page is reached. Every failure is swallowed: losing a bookmark is
 * not a reason to interrupt reading.
 */
export function useReadingProgress({
  chapterId,
  pageIndex,
  pageCount,
  enabled,
  onChapterRead,
}: ReadingProgressOptions): ReadingProgress {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const queued = useRef<{ chapterId: string; page: number } | null>(null)
  const markedRead = useRef<string | null>(null)
  const notify = useRef(onChapterRead)

  useEffect(() => {
    notify.current = onChapterRead
  }, [onChapterRead])

  const flush = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const write = queued.current
    if (!write) return
    queued.current = null
    void setLastPageRead(write.chapterId, write.page).catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!enabled || !chapterId || pageCount === 0) return

    // Moving to another chapter must not discard the page the reader left.
    if (queued.current && queued.current.chapterId !== chapterId) flush()

    queued.current = {
      chapterId,
      page: Math.max(0, Math.min(pageIndex, pageCount - 1)),
    }
    timer.current ??= setTimeout(flush, WRITE_INTERVAL_MS)
  }, [enabled, chapterId, pageIndex, pageCount, flush])

  const mark = useCallback((id: string) => {
    if (markedRead.current === id) return
    markedRead.current = id
    void markChapterRead(id, true).then(
      () => notify.current?.(),
      () => {
        // Let a later page turn try again rather than silently staying unread.
        markedRead.current = null
      },
    )
  }, [])

  useEffect(() => {
    if (!enabled || !chapterId || pageCount === 0) return
    if (pageIndex < pageCount - 1) return
    mark(chapterId)
  }, [enabled, chapterId, pageIndex, pageCount, mark])

  /**
   * The chapter `markReadNow` would act on, mirrored so the returned function
   * keeps its identity across page turns — the reader hands it to memoised
   * controls. Written from an effect rather than during render: effects for a
   * commit have all run before any click in it can fire, so a handler never
   * reads a stale chapter.
   */
  const live = useRef({ enabled, chapterId })
  useEffect(() => {
    live.current = { enabled, chapterId }
  }, [enabled, chapterId])

  const markReadNow = useCallback(() => {
    const { enabled: on, chapterId: id } = live.current
    if (!on || !id) return
    mark(id)
  }, [mark])

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      flush()
    }
  }, [flush])

  return { markReadNow }
}
