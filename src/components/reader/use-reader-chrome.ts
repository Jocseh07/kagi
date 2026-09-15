import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent, RefObject } from 'react'

/** How close to an edge still counts as "at the top" / "at the bottom". */
const EDGE = 8

/** Downward movement that counts as reading on rather than scroll noise. */
const HIDE_DELTA = 8

/** A tap on one of these is that control's business, not the chrome's. */
const INTERACTIVE = 'a, button, input, select, textarea, [role="button"]'

interface ReaderChrome {
  /** Whether the title bar and the floating chapter bar are on screen. */
  visible: boolean
  /** Tap handler for the reading surface. */
  onSurfaceTap(event: MouseEvent<HTMLElement>): void
}

/**
 * Shows and hides the reader's chrome.
 *
 * Reading is the point, so the bars get out of the way as soon as the chapter
 * is being scrolled through, and come back exactly where they are wanted: at
 * the top, at the bottom where the chapter buttons live, and on a tap.
 *
 * The scroll element belongs to whichever viewer is mounted, so the listener is
 * re-attached whenever that changes — `attachKey` is what says it has.
 */
export function useReaderChrome(
  scrollRef: RefObject<HTMLDivElement | null>,
  attachKey: unknown,
): ReaderChrome {
  const [visible, setVisible] = useState(true)
  const lastTop = useRef(0)
  // Mirrors `visible` so the handlers below can tell whether anything is
  // actually changing without reading it through a `setState` updater.
  const visibleRef = useRef(true)

  const apply = useCallback((next: boolean) => {
    if (visibleRef.current === next) return
    visibleRef.current = next
    setVisible(next)
  }, [])

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return

    lastTop.current = container.scrollTop
    let frame = 0

    /*
      `scrollHeight` and `clientHeight` are layout reads, and this runs on every
      scroll frame — enough to force a synchronous layout each time the strip
      has mounted or measured a row. Neither changes from scrolling: the height
      of the content moves when rows are measured, and the height of the box
      moves when the window does. Both are things a ResizeObserver reports, so
      they are cached here and read back for free while scrolling.

      The children are observed as well as the scroller, because the scroller
      is held at the height of the viewport: everything that moves its scroll
      height moves a child instead. All of them, not just the first — the strip
      keeps its pages and its footer in one child, but the text viewer holds
      the prose and the footer as siblings.
    */
    let scrollHeight = container.scrollHeight
    let clientHeight = container.clientHeight
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            scrollHeight = container.scrollHeight
            clientHeight = container.clientHeight
          })
    observer?.observe(container)
    for (const child of container.children) observer?.observe(child)

    const measure = () => {
      frame = 0
      const top = container.scrollTop
      const previous = lastTop.current
      lastTop.current = top

      const atTop = top <= EDGE
      const atBottom = top + clientHeight >= scrollHeight - EDGE

      if (atTop || atBottom) {
        apply(true)
        return
      }
      if (top - previous > HIDE_DELTA) apply(false)
    }

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }

    container.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      container.removeEventListener('scroll', onScroll)
      observer?.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [scrollRef, attachKey, apply])

  const onSurfaceTap = useCallback((event: MouseEvent<HTMLElement>) => {
    const target = event.target
    if (!(target instanceof Element)) return
    // A popover renders through a portal: its clicks bubble here through React
    // but land outside this element in the DOM, and are not surface taps.
    if (!event.currentTarget.contains(target)) return
    if (target.closest(INTERACTIVE)) return
    // Finishing a text selection is a drag, not a tap.
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) return
    apply(!visibleRef.current)
  }, [apply])

  return { visible, onSurfaceTap }
}
