/**
 * Ask the browser for images before anything displays them.
 *
 * Plain `Image` loads with no `crossOrigin`, so they land in the same cache
 * entry the visible `<img>` will later use — set `crossOrigin` here and the
 * request becomes a different cache key, which would warm nothing and cost
 * double.
 *
 * Shared by the reader, which warms pages around the one being read, and by
 * the grids, which warm covers below the fold. The reader also wants each
 * image's shape as it arrives; the grids do not, because a cover's aspect is
 * fixed in CSS. That is what `onLoad` is for.
 */
export function warmImages(
  urls: readonly string[],
  onLoad?: (url: string, image: HTMLImageElement) => void,
): void {
  for (const url of urls) {
    if (!url) continue
    const image = new Image()
    image.referrerPolicy = 'no-referrer'
    if (onLoad) {
      image.addEventListener('load', () => onLoad(url, image), { once: true })
    }
    image.src = url
  }
}
