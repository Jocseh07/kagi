import type { SChapter } from '@/lib/sources/types'

/** The chapter's number for display, or null when the source reported none. */
export function chapterNumberLabel(chapter: SChapter): string | null {
  if (!Number.isFinite(chapter.chapterNumber) || chapter.chapterNumber < 0) return null
  return String(Number(chapter.chapterNumber.toFixed(2)))
}

/**
 * The chapter's name without a leading "Vol. 2 Ch. 46 -" that repeats its
 * number. Novel sources often print the number twice ("Chapter 12 - Chapter 12:
 * Crimson"), so the prefix is stripped up to twice.
 */
export function chapterTitle(chapter: SChapter): string {
  const number = chapterNumberLabel(chapter)
  if (number === null) return chapter.name

  const prefix = new RegExp(
    `^(?:vol(?:ume)?\\.?\\s*\\d+\\s*)?ch(?:apter)?\\.?\\s*${number.replace('.', '\\.')}(?!\\d)\\s*[:.\\-]?\\s*`,
    'i',
  )
  const rest = chapter.name.trim().replace(prefix, '').replace(prefix, '')
  return rest || `Chapter ${number}`
}
