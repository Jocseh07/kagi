import { Link, createFileRoute } from '@tanstack/react-router'
import { Sparkles } from 'lucide-react'

import { MangaListRow, MangaListSkeleton } from '@/components/manga-list-row'
import { PageContainer } from '@/components/page-container'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorPanel } from '@/components/ui/error-panel'
import { isBusy, useAdaptActivity } from '@/lib/adapt/pipeline'
import { supportsAdaptations } from '@/lib/adapt/store'
import { pageKey } from '@/lib/adapt/keys'
import type { Adaptation } from '@/lib/adapt/store'
import { useAdaptations, useBlobUrl } from '@/lib/adapt/use-adaptation'
import { ADAPTED_SOURCE_ID } from '@/lib/sources/adapted'
import { sourceCatalog } from '@/lib/sources/catalog'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/adapt/')({
  component: AdaptationsPage,
  pendingComponent: AdaptationsPending,
})

function AdaptationsPage() {
  const query = useAdaptations()

  return (
    <PageContainer>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Adaptations</h1>
        <Button asChild variant="outline">
          <Link to="/generations">Generation journal</Link>
        </Button>
      </div>

      {/* Pending first: the server never runs the query, so its render matches the client's first one. */}
      {query.isPending ? (
        <MangaListSkeleton count={6} />
      ) : !supportsAdaptations() ? (
        <EmptyState
          icon={Sparkles}
          title="Not available here"
          description="You need a newer browser to adapt novels."
        />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="No adaptations yet"
          description="Open a novel and choose Adapt to turn it into a comic."
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/library">Open library</Link>
            </Button>
          }
        />
      ) : (
        <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {query.data.map((item) => (
            <li key={item.adaptation.id}>
              <AdaptationRow {...item} />
            </li>
          ))}
        </ul>
      )}
    </PageContainer>
  )
}

function AdaptationRow({
  adaptation,
  drawn,
  planned,
}: {
  adaptation: Adaptation
  drawn: number
  planned: number
}) {
  const activity = useAdaptActivity(adaptation.id)
  const firstPage = useBlobUrl(pageKey(adaptation.id, 1, 1))
  const sourceName = sourceCatalog.find((entry) => entry.id === adaptation.sourceId)?.name ?? adaptation.sourceId

  return (
    <Link
      to="/manga/$sourceId/$slug"
      params={{ sourceId: ADAPTED_SOURCE_ID, slug: adaptation.id }}
      className="group block focus-visible:outline-none"
    >
      <MangaListRow
        thumbnailUrl={firstPage ?? adaptation.thumbnailUrl}
        title={adaptation.title}
        meta={
          <>
            <span className="min-w-0 truncate">{sourceName}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0 tabular-nums">
              {drawn} of {planned} drawn
            </span>
            <Status adaptation={adaptation} busy={isBusy(activity)} />
          </>
        }
      />
    </Link>
  )
}

function Status({ adaptation, busy }: { adaptation: Adaptation; busy: boolean }) {
  if (adaptation.status === 'stopped') {
    return <StatusLabel dot="bg-destructive" className="text-destructive" label="Stopped. Open to retry" />
  }
  if (adaptation.status === 'paused') return <StatusLabel label="Paused" />
  if (busy) return <StatusLabel dot="bg-foreground motion-safe:animate-pulse" label="Drawing" />
  return null
}

function StatusLabel({ label, dot, className }: { label: string; dot?: string; className?: string }) {
  return (
    <>
      <span aria-hidden>·</span>
      <span className={cn('flex shrink-0 items-center gap-1', className)}>
        {dot ? <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', dot)} /> : null}
        {label}
      </span>
    </>
  )
}

function AdaptationsPending() {
  return (
    <PageContainer>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Adaptations</h1>
        <Button asChild variant="outline">
          <Link to="/generations">Generation journal</Link>
        </Button>
      </div>
      <MangaListSkeleton count={6} />
    </PageContainer>
  )
}
