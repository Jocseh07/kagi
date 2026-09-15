import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { ReactNode, Ref, RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

import { VirtualList } from '@/components/virtual-list'
import type { Page } from '@/lib/sources/types'
import { useElementWidth } from '@/lib/virtual/use-element-width'

import { ReaderPage } from './reader-page'
import { getPageAspect } from './use-image-preload'

export interface ContinuousViewerHandle {
  scrollTo(pageIndex: number): void
}

interface ContinuousViewerProps {
  pages: Page[]
  scrollRef: RefObject<HTMLDivElement | null>
  /** How far into the chapter the reader has scrolled. */
  onPositionChange(pageIndex: number): void
  footer?: ReactNode
  ref?: Ref<ContinuousViewerHandle>
}

/** How far down the viewport a page has to reach to count as the current one. */
const CURRENT_PAGE_ANCHOR = 0.35

/** Pages ahead and behind that stay mounted, so a scroll never shows a gap. */
const OVERSCAN = 3

/** `max-w-3xl` on the strip below, in pixels — until the column is measured. */
const MAX_CONTENT_WIDTH = 768

/** Share of the screen an unloaded page reserves. */
const PLACEHOLDER_SCREEN_SHARE = 0.7

/**
 * How much taller than the window the placeholder may be.
 *
 * The screen is the right basis because it does not move when the reader goes
 * full screen, but in a short window — or a mobile browser, where `screen`
 * ignores the browser's own bars — it would reserve several viewports of blank
 * space per unloaded page. This bounds that without reintroducing a number
 * that changes on a full-screen transition in the case that matters: on a
 * desktop window past half the screen's height, the clamp never binds.
 */
const PLACEHOLDER_WINDOW_LIMIT = 2

/**
 * Vertical strip, the correct default for webtoons.
 *
 * A chapter can run to hundreds of tall images, so only the pages near the
 * viewport are mounted. Heights come from measuring each page for real; the
 * estimate below is what stands in until then. A page the preloader has already
 * seen is estimated from its true shape, and draws itself at that height too,
 * so it is measured correctly on the way in and does not move again when its
 * image lands. A page that outran the preloader falls back to `placeholderHeight`,
 * which is exactly what an unloaded page draws itself at.
 *
 * Neither number is derived from the window. The strip used to estimate from
 * `window.innerHeight`, which entering full screen changes — and the
 * virtualizer does not recompute existing estimates when `estimateSize`
 * changes, so every page estimated before the transition kept a number built
 * for the old viewport and corrected itself, loudly, on the scroll that
 * reached it. The width comes from the column that is actually drawn, and the
 * placeholder from the screen, which a full-screen transition leaves alone.
 *
 * One chapter at a time. The strip ends where the chapter does, and the reader
 * around it offers the next one as a button rather than laying it out below —
 * so a scroll never changes which chapter is being read.
 */
export function ContinuousViewer({
  pages,
  scrollRef,
  onPositionChange,
  footer,
  ref,
}: ContinuousViewerProps) {
  const [contentNode, setContentNode] = useState<HTMLDivElement | null>(null)
  /**
   * Zero until the column has been measured, which is the first render only.
   * The cap stands in for that one pass: it is what the column settles at on
   * any window wide enough for the difference to matter.
   */
  const measuredWidth = useElementWidth(contentNode)
  const contentWidth = measuredWidth || MAX_CONTENT_WIDTH
  const placeholderHeight = usePlaceholderHeight()
  /**
   * The last page handed to `onPositionChange`, so a scroll that stays on the
   * same page reports nothing. Null rather than page zero: the first
   * measurement after mount has to get through, or a restored reading position
   * would never be announced.
   */
  const lastReported = useRef<number | null>(null)

  const virtualizer = useVirtualizer<HTMLElement, Element>({
    count: pages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: useCallback(
      (index: number) => {
        const page = pages[index]
        const aspect = page ? getPageAspect(page.imageUrl) : null
        if (aspect) return Math.round(contentWidth * aspect)
        return placeholderHeight
      },
      [pages, contentWidth, placeholderHeight],
    ),
    // Keyed by image url as well as position, so a page height measured in one
    // chapter is never reused for the page that replaces it in the next.
    getItemKey: useCallback(
      (index: number) => {
        const page = pages[index]
        return page ? `${index}:${page.imageUrl}` : index
      },
      [pages],
    ),
    overscan: OVERSCAN,
    // React 19 warns about flushSync from inside a lifecycle method.
    useFlushSync: false,
  })

  /**
   * Drop the measured heights when the column's width changes.
   *
   * Every real height is a function of that width, so after a resize the cache
   * holds heights for a column that no longer exists — and the virtualizer has
   * no way to know that on its own. Deliberately not run for the first
   * measurement, which only replaces the estimate the strip already had.
   */
  const lastWidth = useRef(0)
  useLayoutEffect(() => {
    if (measuredWidth === 0) return
    const previous = lastWidth.current
    lastWidth.current = measuredWidth
    if (previous === 0 || previous === measuredWidth) return
    virtualizer.measure()
  }, [measuredWidth, virtualizer])

  /**
   * Which page the reader is on, from the scroll position.
   *
   * Driven by scroll rather than by the virtualizer's own change callback:
   * that only fires when the rendered range moves, which is not the moment the
   * anchor crosses a page — the reader would report the wrong page, and the
   * saved reading position with it. The measurements the virtualizer already
   * holds replace what used to be a walk over every page element in the DOM.
   */
  useEffect(() => {
    const container = scrollRef.current
    if (!container || pages.length === 0) return

    // Only the frame-to-frame repeats are worth suppressing. Anything that
    // re-runs this effect — another chapter's pages, a remount — has moved the
    // strip under the reader, so the next measurement is a fresh one and has to
    // get through whatever it turns out to be.
    lastReported.current = null

    /*
      `clientHeight` is a layout read, and this runs on every scroll frame —
      enough to force a synchronous layout each time the strip has mounted or
      measured a page. Scrolling never changes it: the box only moves when the
      window does, which a ResizeObserver reports, so it is cached here and
      read back for free while scrolling.
    */
    let clientHeight = container.clientHeight
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            clientHeight = container.clientHeight
          })
    observer?.observe(container)

    // A scroll event that did not move the strip — a rubber-band at either
    // end, a horizontal nudge — cannot have crossed a page. Null so the first
    // measurement after mount always runs.
    let lastTop: number | null = null

    let frame = 0
    const measure = () => {
      frame = 0
      const top = container.scrollTop
      if (top === lastTop) return
      lastTop = top

      const anchor = top + clientHeight * CURRENT_PAGE_ANCHOR
      let current = 0
      for (const item of virtualizer.getVirtualItems()) {
        if (item.start > anchor) break
        current = item.index
      }
      // This runs on every scroll frame, but the anchor only crosses a page
      // boundary occasionally. Announcing an unchanged position would re-render
      // the reader around this for nothing, so only a real move is reported.
      if (lastReported.current === current) return
      lastReported.current = current
      onPositionChange(current)
    }

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }

    container.addEventListener('scroll', onScroll, { passive: true })
    measure()

    return () => {
      container.removeEventListener('scroll', onScroll)
      observer?.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [scrollRef, onPositionChange, virtualizer, pages])

  useImperativeHandle(
    ref,
    () => ({
      // The strip only mounts the pages near the viewport, so a jump goes
      // through the virtualizer rather than looking for an element that may
      // not exist yet.
      scrollTo: (pageIndex: number) => {
        virtualizer.scrollToIndex(pageIndex, { align: 'start' })
      },
    }),
    [virtualizer],
  )

  return (
    <div
      ref={scrollRef}
      tabIndex={-1}
      className="relative h-full overflow-y-auto overscroll-contain outline-none"
    >
      <div ref={setContentNode} className="mx-auto w-full max-w-3xl">
        <VirtualList virtualizer={virtualizer} scrollMargin={0}>
          {(index) => {
            const page = pages[index]
            if (!page) return null
            return (
              <ReaderPage
                page={page}
                total={pages.length}
                fit="width"
                placeholderHeight={placeholderHeight}
              />
            )
          }}
        </VirtualList>
        {footer}
      </div>
    </div>
  )
}

/**
 * The height an unloaded page reserves, in pixels.
 *
 * Read once and never updated: that is the entire point. A page that outran
 * the preloader has no shape to lay out at, and whatever stands in for one has
 * to be the same number before and after a full-screen transition, or the
 * strip re-measures its way down the chapter while it is being read.
 */
function usePlaceholderHeight(): number {
  const [height] = useState(() => {
    if (typeof window === 'undefined') return 560
    const basis = Math.min(
      window.screen.height,
      window.innerHeight * PLACEHOLDER_WINDOW_LIMIT,
    )
    return Math.round(basis * PLACEHOLDER_SCREEN_SHARE)
  })

  return height
}
