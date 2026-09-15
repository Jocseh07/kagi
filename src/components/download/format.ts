import type { QueueItem, QueueState } from '@/lib/download/queue-types'

export const QUEUE_STATE_LABELS: Record<QueueState, string> = {
  queued: 'Queued',
  active: 'Downloading',
  paused: 'Paused',
  done: 'Saved',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive'

export const QUEUE_STATE_VARIANTS: Record<QueueState, BadgeVariant> = {
  queued: 'outline',
  active: 'default',
  paused: 'secondary',
  done: 'secondary',
  failed: 'destructive',
  cancelled: 'outline',
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 MB'
  const gigabytes = value / 1024 ** 3
  if (gigabytes >= 1) return `${gigabytes.toFixed(1)} GB`
  return `${Math.round(value / 1024 ** 2)} MB`
}

/**
 * Progress readout for a row. The total is 0 until the runtime has fetched the
 * chapter's page list, which is worth saying out loud rather than showing a
 * percentage of nothing. A row that has not started yet reports its size
 * instead, which is a fact about the chapter rather than progress through it.
 */
export function pageLabel(item: QueueItem): string | null {
  if (item.pagesTotal <= 0) {
    return item.state === 'active' ? 'Fetching page list…' : null
  }
  if (item.state === 'done') return `${item.pagesTotal} pages`
  if (item.pagesCompleted <= 0) return `${item.pagesTotal} pages`
  return percentLabel(item)
}

/** Download position as a whole percent, e.g. "45%". */
export function percentLabel(item: QueueItem): string {
  return `${Math.round(progressRatio(item) * 100)}%`
}

export function progressRatio(item: QueueItem): number {
  if (item.pagesTotal <= 0) return 0
  return Math.min(1, Math.max(0, item.pagesCompleted / item.pagesTotal))
}
