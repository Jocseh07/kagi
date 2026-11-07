export const PAGE_OFFSETS_KEY = 'kagi:reader-page-offsets'
export const PAGE_OFFSET_LIMIT = 200

/**
 * Where in a chapter the reader stopped, as this device last saw it.
 *
 * `page` is the stored position it belongs to: a page index for a comic, a
 * permille for a novel. `offset` is how far into that page, or into paragraph
 * `block` of a novel, as a share of its height, so it means the same spot at
 * any window size. `at` is when it was saved; an entry without it predates the
 * timestamp and never outranks the database row.
 */
export interface PageOffset {
  id: string
  page: number
  offset: number
  block?: number
  at?: number
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function parsePageOffsets(raw: string | null | undefined): PageOffset[] {
  if (!raw) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  const entries: PageOffset[] = []
  for (const value of parsed as unknown[]) {
    if (value === null || typeof value !== 'object') continue
    const item = value as Record<string, unknown>
    if (typeof item.id !== 'string' || !isIndex(item.page)) continue
    if (typeof item.offset !== 'number' || !Number.isFinite(item.offset)) continue
    const entry: PageOffset = { id: item.id, page: item.page, offset: item.offset }
    if (isIndex(item.block)) entry.block = item.block
    if (isIndex(item.at)) entry.at = item.at
    entries.push(entry)
  }
  return entries
}

export interface SpotExtras {
  block?: number
  at?: number
}

export function updatePageOffsets(
  entries: readonly PageOffset[],
  id: string,
  page: number,
  offset: number,
  extras: SpotExtras = {},
): PageOffset[] {
  const entry: PageOffset = {
    id,
    page,
    offset: Math.round(Math.min(1, Math.max(0, Number.isFinite(offset) ? offset : 0)) * 1000) / 1000,
  }
  if (extras.block !== undefined && isIndex(extras.block)) entry.block = extras.block
  if (extras.at !== undefined && isIndex(extras.at)) entry.at = extras.at
  return [...entries.filter((item) => item.id !== id), entry].slice(-PAGE_OFFSET_LIMIT)
}

/**
 * Whether this device's saved spot is more recent than the stored row.
 *
 * True only when the database write that should have followed the spot never
 * landed, such as a tab killed mid-write. Any later write to the row, including
 * one from sync, makes the row win.
 */
export function spotIsNewer(spot: PageOffset | null, rowUpdatedAt: number): boolean {
  return spot?.at !== undefined && spot.at > rowUpdatedAt
}
