/**
 * Where a source's paywall starts, said once above the chapter list.
 *
 * Driven entirely by `SChapter.locked`, so no source is named in code here and
 * any source that learns to report its locks gets this for free. A source that
 * leaves the flag undefined renders nothing at all.
 *
 * The per-row padlock says *which* chapters are paid; this says *how many* are
 * not. Splitting it that way keeps the fact in one place instead of repeating
 * a sentence down every locked row.
 */

import { Lock } from 'lucide-react'

import type { SChapter } from '@/lib/sources/types'

export function LockedChaptersNotice({
  chapters,
  sourceName,
}: {
  /** In the source's own order, so "the first N" means what it says. */
  chapters: SChapter[]
  sourceName: string
}) {
  const message = lockedNotice(chapters, sourceName)
  if (!message) return null

  return (
    // No card and no border: this is a standing fact about the novel, not a
    // failure interrupting you, and elevating it would put chrome above the
    // chapter list it describes.
    <div role="status" className="flex items-center gap-2">
      <Lock aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">{message}</p>
    </div>
  )
}

/**
 * The line to show, or nothing when there is no paywall to describe.
 *
 * Two shapes, because two things happen in practice: a free run followed by a
 * locked tail, which is what WuxiaWorld and most of Webnovel do, and locks
 * scattered through the list, where a boundary would be a lie.
 */
function lockedNotice(
  chapters: SChapter[],
  sourceName: string,
): string | undefined {
  const locked = chapters.filter((chapter) => chapter.locked).length
  if (locked === 0) return undefined

  if (locked === chapters.length) {
    return `Every chapter needs a paid account on ${sourceName}.`
  }

  const free = chapters.findIndex((chapter) => chapter.locked)
  const isTail = chapters.slice(free).every((chapter) => chapter.locked)

  if (!isTail) {
    return `${locked} chapters need a paid account on ${sourceName}.`
  }

  return free === 1
    ? `Only the first chapter is free. The rest need a paid account on ${sourceName}.`
    : `The first ${free} chapters are free. The rest need a paid account on ${sourceName}.`
}
