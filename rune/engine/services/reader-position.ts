import { PAGE_OFFSETS_KEY, parsePageOffsets, updatePageOffsets } from '@/lib/reader/page-offset-model'
import { getPreference, setPreference } from '../adapters/preferences'

export async function comicOffset(chapterId: string, page: number): Promise<number> {
  const entries = parsePageOffsets(await getPreference(PAGE_OFFSETS_KEY))
  const entry = entries.find((value) => value.id === chapterId && value.page === page)
  return entry ? Math.min(0.999, Math.max(0, entry.offset)) : 0
}

export async function saveComicOffset(chapterId: string, page: number, offset: number): Promise<void> {
  const entries = parsePageOffsets(await getPreference(PAGE_OFFSETS_KEY))
  await setPreference(PAGE_OFFSETS_KEY, JSON.stringify(updatePageOffsets(entries, chapterId, page, offset)))
}
