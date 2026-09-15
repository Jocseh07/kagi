import { useEffect, useRef } from 'react'

import { warmImages as warmImageUrls } from '@/lib/images/warm'

/**
 * `naturalHeight / naturalWidth` per page url, learned the first time anything
 * loads that image.
 *
 * Sources do not publish page dimensions, so this is the only way the strip can
 * hold the right amount of space for a page before its image arrives — which is
 * what stops every page that loads from shoving the rest of the chapter down
 * mid-scroll. Module scope rather than state: it is a fact about the image, not
 * about any one render, and a page revisited in the same session already knows.
 */
const aspects = new Map<string, number>()

/** Bounds the map on a long session; the cost of a miss is one re-measure. */
const ASPECT_LIMIT = 4000

/** How tall a page is per unit of width, or null while that is still unknown. */
export function getPageAspect(url: string): number | null {
  return aspects.get(url) ?? null
}

/** Records the shape of a loaded image. Ignores one that failed to decode. */
export function recordPageAspect(url: string, image: HTMLImageElement): void {
  if (!url || aspects.has(url)) return
  const { naturalWidth, naturalHeight } = image
  if (naturalWidth <= 0 || naturalHeight <= 0) return
  if (aspects.size >= ASPECT_LIMIT) aspects.clear()
  aspects.set(url, naturalHeight / naturalWidth)
}

/**
 * Request page images so the browser has them cached before they are shown.
 *
 * The generic warmer plus this module's one extra interest: each image reports
 * its shape back to `aspects` as it lands, which is what lets a page be laid
 * out at the right height before it is scrolled to.
 */
export function warmImages(urls: readonly string[]): void {
  warmImageUrls(urls, recordPageAspect)
}

/**
 * Warm the browser cache for the images around `fromIndex`.
 *
 * One page behind as well as `count` ahead: right-to-left paging and plain
 * backwards navigation both land on the previous page, which would otherwise
 * be the one image in the window that was never asked for.
 *
 * The window runs further ahead than the strip mounts on purpose. A page whose
 * image is already warm knows its shape, so the strip can reserve the right
 * height the moment the page mounts rather than correcting it a beat later.
 *
 * Every url is requested at most once per `urls` array, so scrolling does not
 * re-issue a request for a page the previous index already warmed. Pass a
 * stable `urls` array — a new identity is what resets that bookkeeping.
 */
export function useImagePreload(
  urls: string[],
  fromIndex: number,
  count = 6,
): void {
  const requested = useRef<Set<string>>(new Set())

  useEffect(() => {
    requested.current = new Set()
  }, [urls])

  useEffect(() => {
    const first = Math.max(fromIndex - 1, 0)
    const last = Math.min(fromIndex + count, urls.length - 1)
    const pending: string[] = []

    for (let index = first; index <= last; index++) {
      const url = urls[index]
      if (!url || index === fromIndex) continue
      if (requested.current.has(url)) continue
      requested.current.add(url)
      pending.push(url)
    }

    warmImages(pending)
  }, [urls, fromIndex, count])
}
