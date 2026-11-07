import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'

import { useFontStack } from '@/lib/fonts/load'
import {
  NOVEL_PROGRESS_SCALE,
  permilleToPercent,
  permilleToScrollTop,
  scrollPermille,
} from '@/lib/text/progress'
import { markWordStarts } from '@/lib/text/word-starts'
import type { WordStartStrength } from '@/lib/text/word-starts'

import type { TextReaderSettings } from '@/lib/reader/reader-settings'

/** Quiet time after the last scroll before the exact position is reported. */
const SCROLL_SETTLE_MS = 500

/** How far down the viewport the line being read sits, as in the comic strip. */
const READING_LINE = 0.35

/** A programmatic scroll lands within this of where it was aimed. */
const AIM_TOLERANCE_PX = 2

/** Where the reader is, in terms that survive a reflow. */
export interface TextSpot {
  permille: number
  /** The paragraph under the reading line, or undefined when the prose has none. */
  block?: number
  /** How far into that paragraph, as a share of its height. */
  offset: number
}

export interface TextViewerHandle {
  /** Moves the reader to a stored permille position. */
  scrollToPermille(permille: number): void
  /** Puts paragraph `block`, `offset` of the way in, under the reading line. False when it does not exist. */
  scrollToAnchor(block: number, offset: number): boolean
  /** The current position, measured now. */
  spot(): TextSpot | null
}

interface TextViewerProps {
  /** Sanitised fragment. Never raw source output — see `lib/text/sanitize`. */
  html: string
  settings: TextReaderSettings
  /** Bold word starts at this strength, or null when off. */
  wordStarts: WordStartStrength | null
  scrollRef: RefObject<HTMLDivElement | null>
  ref?: RefObject<TextViewerHandle | null>
  onPositionChange(permille: number): void
  /** Fired once scrolling has stopped for `SCROLL_SETTLE_MS`. */
  onScrollSettle?(): void
  footer?: ReactNode
}

/**
 * Reading surface for a novel chapter.
 *
 * The prose is inserted as HTML because that is what a chapter *is* — the
 * paragraph, emphasis and break structure carries meaning that a plain-text
 * rendering would lose. Everything reaching this component has been through the
 * allowlist sanitiser, which is the only reason `dangerouslySetInnerHTML` is
 * defensible here.
 */
export function TextViewer({
  html,
  settings,
  wordStarts,
  scrollRef,
  ref,
  onPositionChange,
  onScrollSettle,
  footer,
}: TextViewerProps) {
  const frame = useRef<number | null>(null)
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const articleRef = useRef<HTMLElement>(null)
  const lastReported = useRef<number | null>(null)
  /** The paragraph spot to hold on screen when the prose reflows. */
  const anchorRef = useRef<{ block: number; offset: number } | null>(null)
  /** When the reader last scrolled by hand; a reflow then is left alone. */
  const userScrollAt = useRef(0)
  /** Where the last programmatic scroll was aimed, so its event is not taken for the reader's. */
  const aimedTop = useRef<number | null>(null)

  /**
   * Where the prose ends, in the container's scroll coordinates.
   *
   * The end-of-chapter block scrolls inside the same container, so the
   * container's own `scrollHeight` overshoots the chapter by the height of that
   * block — see `scrollPermille`. Rects rather than `offsetTop`: the scroll
   * container is not a positioned ancestor, so `offsetTop` would be measured
   * against some other element entirely.
   */
  const contentBottom = useCallback((container: HTMLDivElement): number => {
    const article = articleRef.current
    if (!article) return container.scrollHeight
    const top = container.getBoundingClientRect().top
    return article.getBoundingClientRect().bottom - top + container.scrollTop
  }, [])

  /**
   * The prose's paragraphs. Sources often wrap the chapter in one element, so
   * single wrappers are stepped through to the level that actually repeats.
   */
  const blocks = useCallback((): HTMLCollection | null => {
    let node: Element | null = articleRef.current
    while (node && node.children.length === 1 && node.firstElementChild!.children.length > 0) {
      node = node.firstElementChild
    }
    if (!node || node.children.length < 2) return null
    return node.children
  }, [])

  const readingLine = (container: HTMLDivElement) =>
    container.getBoundingClientRect().top + container.clientHeight * READING_LINE

  /** Binary search for the last paragraph starting at or above the reading line. */
  const measureAnchor = useCallback(
    (container: HTMLDivElement): { block: number; offset: number } | null => {
      const list = blocks()
      if (!list) return null
      const line = readingLine(container)
      let low = 0
      let high = list.length - 1
      while (low < high) {
        const middle = (low + high + 1) >> 1
        if (list[middle]!.getBoundingClientRect().top <= line) low = middle
        else high = middle - 1
      }
      const rect = list[low]!.getBoundingClientRect()
      const offset = rect.height > 0 ? (line - rect.top) / rect.height : 0
      return { block: low, offset: Math.min(1, Math.max(0, offset)) }
    },
    [blocks],
  )

  const aim = useCallback((container: HTMLDivElement, top: number) => {
    // Clamped as the browser will clamp it, so the scroll event matches.
    const target = Math.max(0, Math.min(top, container.scrollHeight - container.clientHeight))
    aimedTop.current = target
    container.scrollTo({ top: target })
  }, [])

  const applyAnchor = useCallback(
    (block: number, offset: number): boolean => {
      const container = scrollRef.current
      const element = blocks()?.[block]
      if (!container || !element) return false
      const rect = element.getBoundingClientRect()
      const clamped = Math.min(1, Math.max(0, offset))
      aim(container, container.scrollTop + rect.top + clamped * rect.height - readingLine(container))
      anchorRef.current = { block, offset: clamped }
      return true
    },
    [scrollRef, blocks, aim],
  )

  useImperativeHandle(
    ref,
    () => ({
      scrollToPermille(permille: number) {
        const container = scrollRef.current
        if (!container) return
        aim(
          container,
          permilleToScrollTop(permille, contentBottom(container), container.clientHeight),
        )
        anchorRef.current = measureAnchor(container)
      },
      scrollToAnchor: applyAnchor,
      spot() {
        const container = scrollRef.current
        if (!container) return null
        const anchor = measureAnchor(container)
        if (anchor) anchorRef.current = anchor
        return {
          permille: scrollPermille(container.scrollTop, contentBottom(container), container.clientHeight),
          block: anchor?.block,
          offset: anchor?.offset ?? 0,
        }
      },
    }),
    [scrollRef, contentBottom, measureAnchor, applyAnchor, aim],
  )

  /**
   * Holds the reader's paragraph in place when the prose reflows: a rotation,
   * a resized window, a font or size change, or a web font arriving. Not while
   * the reader is scrolling, so it never pulls against a finger.
   *
   * A web font is also caught by its own load event, which lands before the
   * next frame is painted: the resize observer alone would show the reflowed
   * text for one frame before moving it back.
   */
  useEffect(() => {
    const article = articleRef.current
    if (!article) return
    const hold = () => {
      if (performance.now() - userScrollAt.current < SCROLL_SETTLE_MS) return
      const anchor = anchorRef.current
      if (anchor) applyAnchor(anchor.block, anchor.offset)
    }
    // Measured now rather than on the observer's first report, which waits for
    // a paint: a reflow in between still counts as one.
    let width = article.offsetWidth
    let height = article.offsetHeight
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            const nextWidth = article.offsetWidth
            const nextHeight = article.offsetHeight
            if (nextWidth === width && nextHeight === height) return
            width = nextWidth
            height = nextHeight
            hold()
          })
    observer?.observe(article)
    const fonts = typeof document === 'undefined' ? undefined : document.fonts
    fonts?.addEventListener('loadingdone', hold)
    return () => {
      observer?.disconnect()
      fonts?.removeEventListener('loadingdone', hold)
    }
  }, [applyAnchor])

  /**
   * Reports where the reader is. While scrolling only whole-percent steps get
   * through, so the reader around this re-renders a hundred times a chapter
   * rather than a thousand; `exact` sends the precise permille, which is what
   * the resume point is saved from once scrolling stops.
   */
  const report = useCallback(
    (exact: boolean) => {
      const container = scrollRef.current
      if (!container) return
      const permille = scrollPermille(
        container.scrollTop,
        contentBottom(container),
        container.clientHeight,
      )
      const last = lastReported.current
      if (last === permille) return
      const edge = permille === 0 || permille === NOVEL_PROGRESS_SCALE
      if (
        !exact &&
        !edge &&
        last !== null &&
        permilleToPercent(last) === permilleToPercent(permille)
      ) {
        return
      }
      lastReported.current = permille
      onPositionChange(permille)
    },
    [scrollRef, onPositionChange, contentBottom],
  )

  /**
   * Scroll fires far more often than the position is worth recomputing, and
   * reading rects forces layout. One sample per frame is plenty for a progress
   * readout and keeps the reader from janking on a long chapter.
   */
  const handleScroll = useCallback(() => {
    const container = scrollRef.current
    const aimed = aimedTop.current
    if (container && aimed !== null && Math.abs(container.scrollTop - aimed) <= AIM_TOLERANCE_PX) {
      aimedTop.current = null
    } else {
      aimedTop.current = null
      userScrollAt.current = performance.now()
    }
    if (settle.current !== null) clearTimeout(settle.current)
    settle.current = setTimeout(() => {
      settle.current = null
      const settled = scrollRef.current
      if (settled) anchorRef.current = measureAnchor(settled) ?? anchorRef.current
      report(true)
      onScrollSettle?.()
    }, SCROLL_SETTLE_MS)
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      report(false)
    })
  }, [report, scrollRef, measureAnchor, onScrollSettle])

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      if (settle.current !== null) clearTimeout(settle.current)
    },
    [],
  )

  const fontFamily = useFontStack(settings.font)

  const proseStyle = useMemo(
    () =>
      ({
        fontSize: `${settings.fontSize}px`,
        lineHeight: settings.lineHeight,
        maxWidth: `${settings.width}ch`,
        textAlign: settings.justify ? 'justify' : 'start',
        // Undefined, not a stack, when nothing is picked: the prose then
        // inherits whatever font the app itself is wearing.
        fontFamily,
        // `hyphens` needs a language to work; the container sets one below.
        hyphens: settings.justify ? 'auto' : 'manual',
      }) as CSSProperties,
    [settings, fontFamily],
  )

  const shown = useMemo(
    () => (wordStarts ? markWordStarts(html, wordStarts) : html),
    [html, wordStarts],
  )

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="h-full overflow-y-auto overscroll-contain pb-[50dvh] [overflow-anchor:none] [scrollbar-width:none]"
    >
      <article
        ref={articleRef}
        style={proseStyle}
        className="reader-prose mx-auto px-6 py-10 text-fg"
        // Sanitised upstream by `sanitizeChapterHtml`; see the component note.
        dangerouslySetInnerHTML={{ __html: shown }}
      />
      {footer}
    </div>
  )
}
