import { useCallback, useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { History, Trash2 } from 'lucide-react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { MangaCover, mangaSlug } from '@/components/manga-grid'
import { PageContainer } from '@/components/page-container'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorPanel } from '@/components/ui/error-panel'
import { Skeleton } from '@/components/ui/skeleton'
import { VirtualList } from '@/components/virtual-list'
import { clearHistory, deleteHistoryEntry, listHistory } from '@/lib/db/history'
import type { HistoryItem } from '@/lib/db/history'
import { useDatabase } from '@/lib/db/provider'
import { dbKeys } from '@/lib/db/query-keys'
import { readPercent } from '@/lib/text/progress'
import { notify } from '@/lib/ui/toast'
import { usePageVirtualizer } from '@/lib/virtual/use-page-virtualizer'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/history/')({
  component: HistoryPage,
  pendingComponent: HistoryPending,
})

function HistoryPage() {
  const { status, error } = useDatabase()
  const ready = status === 'ready'
  const queryClient = useQueryClient()
  const [confirmingClear, setConfirmingClear] = useState(false)

  const entries = useQuery({
    queryKey: dbKeys.history,
    queryFn: () => listHistory(),
    enabled: ready,
    staleTime: 0,
  })

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: dbKeys.history })

  const remove = useMutation({
    mutationFn: deleteHistoryEntry,
    onSuccess: () => {
      notify.success('Removed from history')
      invalidate()
    },
    onError: (error) => notify.error('Could not remove that entry', error),
  })

  const clear = useMutation({
    mutationFn: clearHistory,
    onSuccess: () => notify.success('History cleared'),
    onError: (error) => notify.error('Could not clear the history', error),
    onSettled: () => {
      setConfirmingClear(false)
      invalidate()
    },
  })

  const items = entries.data ?? []

  return (
    <PageContainer>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">History</h1>

        {items.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmingClear(true)}
          >
            <Trash2 />
            Clear all
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirmingClear}
        onOpenChange={setConfirmingClear}
        title="Clear your reading history?"
        description={`All ${items.length} entries go. Your library and reading progress are untouched — only the record of what you opened and when.`}
        confirmLabel="Clear all"
        busyLabel="Clearing…"
        busy={clear.isPending}
        onConfirm={() => clear.mutate()}
      />

      {status === 'error' ? (
        <ErrorPanel
          error={error ?? new Error('The library database is unavailable.')}
        />
      ) : entries.isError ? (
        <ErrorPanel error={entries.error} onRetry={() => void entries.refetch()} />
      ) : entries.isPending ? (
        <HistorySkeleton />
      ) : items.length === 0 ? (
        <EmptyHistory />
      ) : (
        <HistoryList
          items={items}
          busyId={remove.isPending ? remove.variables : null}
          onDelete={(id) => remove.mutate(id)}
        />
      )}
    </PageContainer>
  )
}

/**
 * The history is unbounded — every chapter ever opened lands in it — so only
 * the rows in view are drawn. The card chrome moves onto the virtual list's
 * own container, and the hairline between rows onto each row, since absolutely
 * positioned siblings cannot be divided by the container.
 */
function HistoryList({
  items,
  busyId,
  onDelete,
}: {
  items: readonly HistoryItem[]
  busyId: string | null
  onDelete(id: string): void
}) {
  const { listRef, virtualizer, scrollMargin } = usePageVirtualizer({
    count: items.length,
    estimateSize: useCallback(() => HISTORY_ROW_HEIGHT, []),
    getItemKey: useCallback((index: number) => items[index]?.id ?? index, [items]),
  })

  return (
    <VirtualList
      virtualizer={virtualizer}
      listRef={listRef}
      scrollMargin={scrollMargin}
      role="list"
      itemRole="listitem"
      className="overflow-hidden rounded-lg border border-border bg-card"
    >
      {(index) => {
        const item = items[index]
        if (!item) return null
        return (
          <HistoryRow
            item={item}
            busy={busyId === item.id}
            onDelete={() => onDelete(item.id)}
            className={index < items.length - 1 ? 'border-b border-border' : undefined}
          />
        )
      }}
    </VirtualList>
  )
}

/** A 40px cover at 2:3 plus the row's own padding; measured for real on mount. */
const HISTORY_ROW_HEIGHT = 80

function HistoryRow({
  item,
  busy,
  onDelete,
  className,
}: {
  item: HistoryItem
  busy: boolean
  onDelete(): void
  className?: string
}) {
  // The group belongs on the same line as the chapter: on an aggregator the
  // same chapter exists three times over, and the name alone does not say
  // which one this was.
  const detail = [item.chapterName, item.scanlator, progressLabel(item)]
    .filter((value): value is string => Boolean(value))
    .join(' · ')
  const slug = mangaSlug({
    url: item.mangaUrl,
    title: item.mangaTitle,
    status: 'unknown',
    initialized: true,
    memo: item.mangaMemo ?? undefined,
  })

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-secondary',
        className,
      )}
    >
      <Link
        to="/manga/$sourceId/$slug"
        params={{ sourceId: item.sourceId, slug }}
        className="w-10 shrink-0"
        aria-label={item.mangaTitle}
      >
        <MangaCover url={item.thumbnailUrl ?? undefined} title={item.mangaTitle} />
      </Link>

      <Link
        to="/reader/$sourceId/$slug/$chapter"
        params={{
          sourceId: item.sourceId,
          slug,
          chapter: chapterKey(item.chapterUrl, item.chapterNumber),
        }}
        className="min-w-0 flex-1"
      >
        <p className="truncate text-sm font-medium">{item.mangaTitle}</p>
        <p className="truncate text-xs text-muted-foreground">{detail}</p>
        <p className="text-xs text-muted-foreground">{relativeTime(item.readAt)}</p>
      </Link>

      <Button
        variant="ghost"
        size="sm"
        className="shrink-0"
        disabled={busy}
        aria-label={`Remove ${item.mangaTitle} from history`}
        onClick={onDelete}
      >
        <Trash2 />
      </Button>
    </div>
  )
}

/** Only meaningful mid-chapter; a finished chapter reads as read. */
function progressLabel(item: HistoryItem): string | null {
  if (item.read || item.lastPageRead <= 0) return null
  const percent = readPercent(item.lastPageRead, item.pageCount)
  return percent === null ? `page ${item.lastPageRead + 1}` : `${percent}%`
}

function EmptyHistory() {
  return (
    <EmptyState
      icon={History}
      title="Nothing read yet"
      description="Chapters you read show up here, with a link back to where you stopped."
      action={
        <Button asChild variant="outline" size="sm">
          <Link to="/library">Open library</Link>
        </Button>
      }
    />
  )
}

/**
 * The route's shape while its chunk is still loading.
 *
 * The heading is real rather than a grey bar: it is a constant, so there is
 * nothing to wait for and nothing that can shift once the data lands. Only the
 * part that genuinely is unknown is drawn as a placeholder.
 */
function HistoryPending() {
  return (
    <PageContainer>
      <h1 className="text-xl font-semibold tracking-tight">History</h1>
      <HistorySkeleton />
    </PageContainer>
  )
}

function HistorySkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="flex items-center gap-3">
          <Skeleton className="aspect-[2/3] w-10 shrink-0 rounded-lg" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  )
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['week', 7 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
]

function relativeTime(timestamp: number): string {
  const elapsed = timestamp - Date.now()
  for (const [unit, size] of UNITS) {
    if (Math.abs(elapsed) >= size) {
      return RELATIVE.format(Math.round(elapsed / size), unit)
    }
  }
  return 'just now'
}

/** Mirrors `chapterKeyOf` in the reader: the last url segment names a chapter. */
function chapterKey(url: string, chapterNumber: number): string {
  return url.split('/').pop() ?? String(chapterNumber)
}
