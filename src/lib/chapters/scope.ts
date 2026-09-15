import type { SChapter } from '@/lib/sources/types'

import { scanlatorKey } from './filter-state'

/**
 * Narrowing a series to the group it is being read from.
 *
 * An aggregator carries the same chapters from several groups, so a series is
 * really several parallel series sharing a cover. Everything that walks a
 * chapter list in order — reading forward, resuming, queueing a backlog —
 * belongs to one of them, and crossing between them hands the reader a
 * translation they did not choose.
 *
 * An empty selection means every group, which is both the default and the way
 * to opt out.
 */
export function scopeToGroups(
  chapters: readonly SChapter[],
  selected: readonly string[],
): SChapter[] {
  if (selected.length === 0) return [...chapters]
  return chapters.filter((chapter) =>
    selected.includes(scanlatorKey(chapter.scanlator)),
  )
}

/**
 * The chapters the reader may move between, given the one that is open.
 *
 * Scoped to the *open* chapter's group rather than to the stored selection,
 * because a chapter can be reached from outside the series page — a history
 * entry, an update — and clamping to the picked group there would refuse to
 * read forward from what is actually on screen. The stored selection is still
 * what decides *whether* to scope at all: a reader on "All groups" has asked
 * for one continuous list and gets it.
 *
 * The open chapter being unknown — the chapter list has not arrived, or the
 * source no longer lists it — leaves the list unscoped, which is the same
 * navigation the reader had before any of this.
 */
export function readerScope(
  chapters: readonly SChapter[],
  open: SChapter | null,
  selected: readonly string[],
): SChapter[] {
  if (selected.length === 0 || !open) return [...chapters]
  const group = scanlatorKey(open.scanlator)
  return chapters.filter((chapter) => scanlatorKey(chapter.scanlator) === group)
}
