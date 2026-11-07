import { PAGE_OFFSETS_KEY, parsePageOffsets, updatePageOffsets } from './page-offset-model'
import type { PageOffset, SpotExtras } from './page-offset-model'

/**
 * Remembers where in a chapter the reader stopped. Local only: the position it
 * belongs to is stored with it, so a resume point moved by sync simply stops
 * matching.
 */
export function savePageOffset(
  chapterId: string,
  page: number,
  offset: number,
  extras: SpotExtras = {},
): void {
  try {
    const entries = parsePageOffsets(localStorage.getItem(PAGE_OFFSETS_KEY))
    localStorage.setItem(
      PAGE_OFFSETS_KEY,
      JSON.stringify(updatePageOffsets(entries, chapterId, page, offset, extras)),
    )
  } catch {
    // Private-mode storage refusal only costs the spot within the page.
  }
}

/** The saved spot for this chapter, whatever position it was saved at. */
export function readPageSpot(chapterId: string): PageOffset | null {
  try {
    return parsePageOffsets(localStorage.getItem(PAGE_OFFSETS_KEY)).find((item) => item.id === chapterId) ?? null
  } catch {
    return null
  }
}
