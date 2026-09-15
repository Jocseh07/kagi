import { useCallback, useLayoutEffect, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Virtualizer } from '@tanstack/react-virtual'

import { useScrollElement } from './scroll-context'

interface PageVirtualizerOptions {
  count: number
  /**
   * Height of a row before it has been measured. Rows are measured for real
   * once mounted, so this only has to be close enough to keep the scrollbar
   * from lurching; err on the large side.
   */
  estimateSize: (index: number) => number
  /** Stable identity per row, so measurements survive a reorder. */
  getItemKey?: (index: number) => string | number
  overscan?: number
}

export interface PageVirtualizer {
  /** Goes on the element that wraps the rows. */
  listRef: (node: HTMLDivElement | null) => void
  virtualizer: Virtualizer<HTMLElement, Element>
  /**
   * Distance from the top of the scrolled content to the top of the list. Row
   * offsets are absolute within the scroller, so each row is drawn at
   * `start - scrollMargin` relative to the list.
   */
  scrollMargin: number
}

/**
 * A virtualizer for a list that shares the app's one scrolling element with
 * the page furniture drawn above it.
 *
 * The virtualizer measures offsets from the top of the scrolled content, but
 * the list starts wherever the page's heading, search box and filters end, so
 * that distance has to be measured and fed back in as `scrollMargin`. It is
 * re-measured whenever the scroller or the page content changes size, which is
 * what moves the list.
 */
export function usePageVirtualizer({
  count,
  estimateSize,
  getItemKey,
  overscan = 6,
}: PageVirtualizerOptions): PageVirtualizer {
  const scrollElement = useScrollElement()
  const [listElement, setListElement] = useState<HTMLDivElement | null>(null)
  const [scrollMargin, setScrollMargin] = useState(0)

  const measure = useCallback(() => {
    if (!scrollElement || !listElement) return
    // `offsetTop` is measured against the nearest positioned ancestor, which
    // here is the document — it would fold the app header into the offset.
    const next = Math.round(
      listElement.getBoundingClientRect().top -
        scrollElement.getBoundingClientRect().top +
        scrollElement.scrollTop,
    )
    // React bails out of an unchanged value, so a resize that did not move the
    // list costs nothing.
    setScrollMargin((current) => (current === next ? current : next))
  }, [scrollElement, listElement])

  useLayoutEffect(() => {
    if (!scrollElement || !listElement) return
    measure()

    // The scroller catches a window resize; the page content catches anything
    // above the list growing or collapsing, which is what moves the list.
    const observer = new ResizeObserver(measure)
    observer.observe(scrollElement)
    const content = scrollElement.firstElementChild
    if (content) observer.observe(content)

    return () => observer.disconnect()
  }, [scrollElement, listElement, measure])

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollElement,
    estimateSize,
    getItemKey,
    overscan,
    scrollMargin,
    // React 19 warns about flushSync from inside a lifecycle method, and a
    // frame's delay in swapping rows is not worth the warning.
    useFlushSync: false,
  })

  return { listRef: setListElement, virtualizer, scrollMargin }
}
