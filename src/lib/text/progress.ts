/**
 * Reading position in a novel chapter.
 *
 * A comic chapter has discrete pages, so its resume point is a page index. Prose
 * has none, so the position is stored as a fraction of the way down the chapter,
 * scaled to an integer because `chapters.last_page_read` is an INTEGER column
 * shared with comics.
 *
 * Permille rather than percent: at 1% granularity the resume point of a long
 * chapter lands up to a screen or two away from where the reader actually
 * stopped, which is exactly the annoyance the resume point exists to avoid.
 */
export const NOVEL_PROGRESS_SCALE = 1000

/** Sub-pixel scroll offsets must still read as the end of the chapter. */
const END_TOLERANCE_PX = 2

/**
 * Fraction of a chapter that has been read, as a permille integer.
 *
 * `contentBottom` is where the *prose* ends in the container's scroll
 * coordinates, not the container's full `scrollHeight`: anything rendered below
 * the chapter — the end-of-chapter block and its buttons — is not reading, and
 * counting it would leave a chapter read to its last paragraph short of the
 * end and so never marked read.
 *
 * Measured against the *scrollable* distance, so a chapter shorter than the
 * viewport has nothing to scroll and reads as complete rather than as zero —
 * otherwise a short chapter could never be marked read.
 */
export function scrollPermille(
  scrollTop: number,
  contentBottom: number,
  clientHeight: number,
): number {
  const scrollable = contentBottom - clientHeight
  if (scrollable <= 0) return NOVEL_PROGRESS_SCALE
  // Fractional scroll offsets — browser zoom, device pixel ratio — otherwise
  // land a permille short of the end however far the reader scrolls.
  if (scrollTop >= scrollable - END_TOLERANCE_PX) return NOVEL_PROGRESS_SCALE
  const ratio = scrollTop / scrollable
  return clamp(Math.round(ratio * NOVEL_PROGRESS_SCALE))
}

/**
 * Pixel offset a stored permille position corresponds to in a container.
 *
 * `contentBottom` means what it does above, so a resume shares the denominator
 * the position was recorded against.
 */
export function permilleToScrollTop(
  permille: number,
  contentBottom: number,
  clientHeight: number,
): number {
  const scrollable = Math.max(0, contentBottom - clientHeight)
  return (clamp(permille) / NOVEL_PROGRESS_SCALE) * scrollable
}

export function permilleToPercent(permille: number): number {
  return Math.round((clamp(permille) / NOVEL_PROGRESS_SCALE) * 100)
}

/**
 * Reading position as a whole percent, or null when there is no total to take a
 * percentage of.
 *
 * Works for either content kind without being told which: `lastPageRead` is a
 * page index for a comic and a permille scroll position for a novel, and
 * `pageCount` is the matching total in both cases — see `chapters` in the
 * schema.
 */
export function readPercent(
  lastPageRead: number,
  pageCount: number,
): number | null {
  if (!Number.isFinite(lastPageRead) || pageCount <= 0) return null
  const ratio = (lastPageRead + 1) / pageCount
  return Math.max(0, Math.min(100, Math.round(ratio * 100)))
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(NOVEL_PROGRESS_SCALE, value))
}
