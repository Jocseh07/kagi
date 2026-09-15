/**
 * The chapter list's filter and sort state.
 *
 * Kept apart from the dialog that edits it so both the dialog and the page that
 * applies it can import the shape without either importing the other, and so
 * the component file exports nothing but components.
 */

/** 0 = ignore, 1 = only these, 2 = only the others. Mirrors Mihon. */
export type ChapterTriState = 0 | 1 | 2

export type ChapterSortKey = 'number' | 'uploadDate'

export interface ChapterFilterState {
  downloaded: ChapterTriState
  unread: ChapterTriState
  bookmarked: ChapterTriState
  /**
   * The scanlation group being followed, by the name the source reports, as
   * a one-item list. Empty means no group has been chosen yet, which is the
   * only sensible default for a series whose groups are not known until its
   * chapters have loaded; the series page then derives one.
   */
  scanlators: string[]
  sort: ChapterSortKey
  ascending: boolean
}

/**
 * Stands for "no group named" in a selection.
 *
 * Sources do not always attribute a chapter — Mangadot's scraped uploads carry
 * a null group — and those chapters need to be selectable too, or picking any
 * group silently hides a slice of the list with nothing in the dialog to
 * explain it. The empty string can never collide with a real group, since a
 * name that trims to nothing is treated as absent.
 */
export const UNGROUPED = ''

export const UNGROUPED_LABEL = 'Unknown group'

/** A group offered in the dialog, with how many chapters it accounts for. */
export interface ScanlatorOption {
  /** The scanlator name as the source reports it, or `UNGROUPED`. */
  name: string
  count: number
  /** Chapters of this group already read, and already saved offline. */
  readCount: number
  downloadedCount: number
}

/** Whether there is any sign of having read or saved this group's chapters. */
export function isGroupStarted(option: ScanlatorOption): boolean {
  return option.readCount > 0 || option.downloadedCount > 0
}

/**
 * The group a series looks like it is being followed from.
 *
 * Only a guess, and only ever used for a series the reader has never made a
 * choice on for this series. The group of the chapter last opened is
 * the answer when it is still on offer; otherwise the first option, since the
 * list arrives sorted started-first, then largest-first.
 */
export function pickFollowedGroup(
  options: ScanlatorOption[],
  lastRead: string | null,
): string | null {
  if (options.length === 0) return null
  if (lastRead !== null) {
    const match = options.find((option) => option.name === lastRead)
    if (match && match.count > 0) return match.name
  }
  return options[0]!.name
}

/** The `settings` key prefix; `library.ts` builds the same key in SQL. */
export const CHAPTER_FILTERS_KEY_PREFIX = 'chapter-filters:v2:'

/**
 * Where a series' filter choices live in the `settings` table.
 *
 * v2 retires records written when the default direction was newest-first;
 * those stored a `false` the reader never actually chose.
 */
export function chapterFiltersKey(sourceId: string, mangaUrl: string): string {
  return `${CHAPTER_FILTERS_KEY_PREFIX}${sourceId}:${mangaUrl}`
}

export function parseChapterFilters(raw: string): ChapterFilterState {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return defaultChapterFilters()
    const value = parsed as Partial<Record<keyof ChapterFilterState, unknown>>
    return {
      downloaded: triStateOf(value.downloaded),
      unread: triStateOf(value.unread),
      bookmarked: triStateOf(value.bookmarked),
      // The empty string is meaningful here — it is `UNGROUPED` — so this
      // checks the type and nothing else.
      scanlators: Array.isArray(value.scanlators)
        ? value.scanlators.filter((name): name is string => typeof name === 'string')
        : [],
      sort: value.sort === 'uploadDate' ? 'uploadDate' : 'number',
      // Only an explicit saved choice overrides the earliest-first default.
      ascending:
        typeof value.ascending === 'boolean'
          ? value.ascending
          : defaultChapterFilters().ascending,
    }
  } catch {
    return defaultChapterFilters()
  }
}

function triStateOf(value: unknown): ChapterTriState {
  return value === 1 || value === 2 ? value : 0
}

/** The name a chapter should be filed under, whether or not it has one. */
export function scanlatorKey(scanlator: string | undefined): string {
  return scanlator?.trim() || UNGROUPED
}

/**
 * A fresh default. This is a function rather than a shared constant because the
 * state now holds an array: one exported object would hand the same array to
 * every series on screen, and a single in-place edit would leak across all of
 * them.
 */
export function defaultChapterFilters(): ChapterFilterState {
  return {
    downloaded: 0,
    unread: 0,
    bookmarked: 0,
    scanlators: [],
    sort: 'number',
    ascending: true,
  }
}
