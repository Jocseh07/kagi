import { useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'

import { findFont } from '@/lib/fonts/catalog'
import { permilleToScrollTop, scrollPermille } from '@/lib/text/progress'

import type { TextReaderSettings } from './reader-settings'

export interface TextViewerHandle {
  /** Moves the reader to a stored permille position. */
  scrollToPermille(permille: number): void
}

interface TextViewerProps {
  /** Sanitised fragment. Never raw source output — see `lib/text/sanitize`. */
  html: string
  settings: TextReaderSettings
  scrollRef: RefObject<HTMLDivElement | null>
  ref?: RefObject<TextViewerHandle | null>
  onPositionChange(permille: number): void
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
  scrollRef,
  ref,
  onPositionChange,
  footer,
}: TextViewerProps) {
  const frame = useRef<number | null>(null)
  const articleRef = useRef<HTMLElement>(null)

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

  useImperativeHandle(
    ref,
    () => ({
      scrollToPermille(permille: number) {
        const container = scrollRef.current
        if (!container) return
        container.scrollTo({
          top: permilleToScrollTop(
            permille,
            contentBottom(container),
            container.clientHeight,
          ),
        })
      },
    }),
    [scrollRef, contentBottom],
  )

  /**
   * Scroll fires far more often than the position is worth recomputing, and
   * reading `scrollHeight` forces layout. One sample per frame is plenty for a
   * progress readout and keeps the reader from janking on a long chapter.
   */
  const handleScroll = useCallback(() => {
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      const container = scrollRef.current
      if (!container) return
      onPositionChange(
        scrollPermille(
          container.scrollTop,
          contentBottom(container),
          container.clientHeight,
        ),
      )
    })
  }, [scrollRef, onPositionChange, contentBottom])

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    },
    [],
  )

  const proseStyle = {
    fontSize: `${settings.fontSize}px`,
    lineHeight: settings.lineHeight,
    maxWidth: `${settings.width}ch`,
    textAlign: settings.justify ? 'justify' : 'start',
    // Undefined, not a stack, when nothing is picked: the prose then inherits
    // whatever font the app itself is wearing.
    fontFamily: findFont(settings.font)?.stack,
    // `hyphens` needs a language to work; the container sets one below.
    hyphens: settings.justify ? 'auto' : 'manual',
  } as CSSProperties

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="h-full overflow-y-auto overscroll-contain"
    >
      <article
        ref={articleRef}
        style={proseStyle}
        className="reader-prose mx-auto px-6 py-10 text-fg"
        // Sanitised upstream by `sanitizeChapterHtml`; see the component note.
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {footer}
    </div>
  )
}
