import type { SChapter } from '@/lib/sources/types'

/** The route param that identifies a chapter is the trailing url segment. */
export function chapterKeyOf(chapter: Pick<SChapter, 'url' | 'chapterNumber'> & Partial<SChapter>): string {
  return chapter.url.split('/').pop() ?? String(chapter.chapterNumber)
}
