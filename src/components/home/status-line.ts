import { relativeTime } from '@/components/updates/format'
import type { LibraryProgress } from '@/lib/db/home'

import { formatCount } from './format'

export function notStartedLine(item: LibraryProgress): string {
  const chapters = `${formatCount(item.total)} ch`
  return item.dateAdded ? `${chapters} · added ${relativeTime(item.dateAdded)}` : chapters
}

export function pausedLine(item: LibraryProgress): string {
  const at = `Ch. ${formatCount(item.readCount)}/${formatCount(item.total)}`
  return item.lastRead ? `${at} · ${relativeTime(item.lastRead)}` : at
}

export function caughtUpLine(item: LibraryProgress): string {
  const read = `All ${formatCount(item.total)} read`
  return item.status === 'completed' ? `${read} · Finished` : read
}

export function pausedPercent(item: LibraryProgress): number | null {
  return item.total > 0 ? Math.round((item.readCount / item.total) * 100) : null
}
