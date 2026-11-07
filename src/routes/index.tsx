import { useMemo } from 'react'
import { Link, createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { BookOpen, Library } from 'lucide-react'

import { AddedView } from '@/components/home/added-view'
import type { AddedFilter } from '@/components/home/added-view'
import { ContinueReading } from '@/components/home/continue-reading'
import type { BadgeCounts } from '@/components/home/continue-reading'
import { OfflineShelf } from '@/components/home/offline-shelf'
import { PausedShelf } from '@/components/home/paused-shelf'
import { ShelfSkeleton } from '@/components/home/shelf'
import { StartNext } from '@/components/home/start-next'
import { PageContainer } from '@/components/page-container'
import { FirstSyncNotice } from '@/components/sync/first-sync-notice'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorPanel } from '@/components/ui/error-panel'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  groupLibraryForHome,
  listContinueItems,
  listLibraryProgress,
  listSavedBySeries,
} from '@/lib/db/home'
import { useDatabase } from '@/lib/db/provider'
import { dbKeys } from '@/lib/db/query-keys'
import { hasOnboarded, hasProfile } from '@/lib/profile/store'
import { useFirstSyncPending } from '@/lib/sync/first-sync'
import { cn } from '@/lib/utils'

type HomeTab = 'reading' | 'added'

interface HomeSearch {
  /** Absent means Reading, the default tab. */
  tab?: 'added'
  /** Absent means All. */
  filter?: Exclude<AddedFilter, 'all'>
}

const FILTERS: readonly Exclude<AddedFilter, 'all'>[] = ['not-started', 'paused', 'caught-up']

/** The resume card and six tiles; the rest only decide what Added leaves out. */
const CONTINUE_SHOWN = 7

export const Route = createFileRoute('/')({
  // First run lands on the welcome. Both reads are synchronous localStorage
  // reads, so this resolves before the first paint.
  beforeLoad: () => {
    if (!hasProfile() && !hasOnboarded()) throw redirect({ to: '/welcome' })
  },
  validateSearch: (search: Record<string, unknown>): HomeSearch => {
    const next: HomeSearch = {}
    if (search.tab === 'added') next.tab = 'added'
    const filter = FILTERS.find((value) => value === search.filter)
    if (filter) next.filter = filter
    return next
  },
  component: HomePage,
  pendingComponent: HomePending,
})

function HomePage() {
  const { status, error } = useDatabase()
  const ready = status === 'ready'
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const firstSyncPending = useFirstSyncPending()

  const continueQuery = useQuery({
    queryKey: [...dbKeys.history, 'home'],
    queryFn: () => listContinueItems(50),
    enabled: ready,
    staleTime: 0,
  })
  const savedQuery = useQuery({
    queryKey: [...dbKeys.savedChapters, 'by-series'],
    queryFn: listSavedBySeries,
    enabled: ready,
    staleTime: 0,
  })
  const libraryQuery = useQuery({
    queryKey: [...dbKeys.library, 'home-progress'],
    queryFn: listLibraryProgress,
    enabled: ready,
    staleTime: 0,
  })
  const continueItems = useMemo(() => continueQuery.data ?? [], [continueQuery.data])
  const groups = useMemo(() => {
    const reading = new Set(continueItems.map((item) => item.history.mangaId))
    return groupLibraryForHome(libraryQuery.data ?? [], reading)
  }, [continueItems, libraryQuery.data])
  const counts: BadgeCounts = useMemo(
    () =>
      new Map(
        (libraryQuery.data ?? []).map((row) => [
          row.id,
          { unread: row.unreadCount, saved: row.downloadedCount },
        ]),
      ),
    [libraryQuery.data],
  )
  const kindOf = useMemo(
    () => new Map((libraryQuery.data ?? []).map((row) => [row.id, row.contentKind])),
    [libraryQuery.data],
  )

  const tab: HomeTab = search.tab ?? 'reading'
  const filter: AddedFilter = search.filter ?? 'all'

  const setTab = (next: HomeTab) =>
    void navigate({
      search: (prev) => ({
        ...prev,
        tab: next === 'added' ? 'added' : undefined,
        filter: next === 'added' ? prev.filter : undefined,
      }),
    })
  const setFilter = (next: AddedFilter) =>
    void navigate({
      search: (prev) => ({ ...prev, tab: 'added', filter: next === 'all' ? undefined : next }),
    })

  // Each panel reads its own query, so one slow or failed read never holds the
  // others back. Only the first-run check needs every list it counts.
  const settled = continueQuery.isSuccess && libraryQuery.isSuccess && savedQuery.isSuccess
  const libraryCount = libraryQuery.data?.length ?? 0
  const nothingYet =
    settled && continueItems.length === 0 && libraryCount === 0 && (savedQuery.data ?? []).length === 0
  // What Added leaves out depends on what is being read, so it waits on both.
  const groupInputs = [libraryQuery, continueQuery]
  const groupsFailed = groupInputs.find((query) => query.isError)
  const groupsReady = groupInputs.every((query) => query.isSuccess)

  let reading
  let added
  if (status === 'error') {
    const panel = <ErrorPanel error={error} />
    reading = panel
    added = panel
  } else if (nothingYet && firstSyncPending) {
    reading = (
      <div className="flex flex-col gap-4">
        <FirstSyncNotice />
        <ReadingSkeleton />
      </div>
    )
    added = (
      <div className="flex flex-col gap-4">
        <FirstSyncNotice />
        <AddedSkeleton />
      </div>
    )
  } else if (nothingYet) {
    reading = <StartReading />
    added = <NothingAdded />
  } else {
    reading = (
      <div className="grid grid-cols-1 gap-x-6 gap-y-8 lg:grid-cols-12">
        {continueQuery.isError ? (
          <ErrorPanel
            error={continueQuery.error}
            onRetry={() => void continueQuery.refetch()}
            className="lg:col-span-12"
          />
        ) : !continueQuery.isSuccess ? (
          <ContinueSkeleton className="lg:col-span-12" />
        ) : continueItems.length > 0 ? (
          <ContinueReading
            items={continueItems.slice(0, CONTINUE_SHOWN)}
            counts={counts}
            className="lg:col-span-12"
          />
        ) : (
          <EmptyState
            icon={BookOpen}
            title="Nothing in progress"
            description="Chapters you open show here, so you can pick up where you stopped."
            action={
              <Button asChild variant="outline" size="sm">
                <Link to="/history">History</Link>
              </Button>
            }
            className="lg:col-span-12"
          />
        )}
        {groupsFailed ? (
          <ErrorPanel
            error={groupsFailed.error}
            onRetry={() => void groupsFailed.refetch()}
            className="lg:col-span-8"
          />
        ) : !groupsReady ? (
          <ShelfSkeleton className="lg:col-span-8" />
        ) : (
          <PausedShelf
            series={groups.paused}
            onSeeAll={() => setFilter('paused')}
            className="lg:col-span-8"
          />
        )}
        {savedQuery.isError ? (
          <ErrorPanel
            error={savedQuery.error}
            onRetry={() => void savedQuery.refetch()}
            className="lg:col-span-4"
          />
        ) : !savedQuery.isSuccess ? (
          <ShelfSkeleton count={3} narrow className="lg:col-span-4" />
        ) : (
          <OfflineShelf series={savedQuery.data} kindOf={kindOf} className="lg:col-span-4" />
        )}
        {groupsReady ? (
          <StartNext
            series={groups.notStarted}
            onSeeAll={() => setFilter('not-started')}
            className="lg:col-span-8"
          />
        ) : null}
      </div>
    )
    added = groupsFailed ? (
      <ErrorPanel error={groupsFailed.error} onRetry={() => void groupsFailed.refetch()} />
    ) : !groupsReady ? (
      <AddedSkeleton />
    ) : groups.notStarted.length + groups.paused.length + groups.caughtUp.length > 0 ? (
      <AddedView
        groups={groups}
        libraryCount={libraryCount}
        filter={filter}
        onFilterChange={setFilter}
      />
    ) : (
      <NothingAdded />
    )
  }

  return (
    <PageContainer>
      <h1 className="sr-only">Home</h1>
      <Tabs value={tab} onValueChange={(next) => setTab(next as HomeTab)} className="gap-page">
        <TabsList aria-label="Home" className="w-full sm:w-fit">
          <TabsTrigger value="reading" className="sm:px-4">
            Reading
          </TabsTrigger>
          <TabsTrigger value="added" className="sm:px-4">
            Added
          </TabsTrigger>
        </TabsList>
        <TabsContent value="reading">{reading}</TabsContent>
        <TabsContent value="added">{added}</TabsContent>
      </Tabs>
    </PageContainer>
  )
}

function StartReading() {
  return (
    <EmptyState
      icon={BookOpen}
      title="Start reading"
      description="Find a series in Browse, or bring your Mihon library across."
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild>
            <Link to="/browse">Browse sources</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link to="/settings" search={{ tab: 'data', billing: undefined }}>
              Import a backup
            </Link>
          </Button>
        </div>
      }
    />
  )
}

function NothingAdded() {
  return (
    <EmptyState
      icon={Library}
      title="Nothing else added"
      description="Series you add from Browse show here until you start reading them."
      action={
        <Button asChild variant="outline">
          <Link to="/browse">Browse sources</Link>
        </Button>
      }
    />
  )
}

function ReadingSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading home"
      className="grid grid-cols-1 gap-x-6 gap-y-8 lg:grid-cols-12"
    >
      <ContinueSkeleton className="lg:col-span-12" />
      <ShelfSkeleton className="lg:col-span-8" />
      <ShelfSkeleton count={3} narrow className="lg:col-span-4" />
    </div>
  )
}

/** The resume card beside a shelf of six, in the shapes they load into. */
function ContinueSkeleton({ className }: { className?: string }) {
  return (
    <div
      aria-busy="true"
      className={cn('@container grid min-w-0 grid-cols-1 gap-4 @5xl:grid-cols-12 @5xl:gap-6', className)}
    >
      <div className="flex gap-4 rounded-lg border border-border bg-card p-3 md:gap-6 md:p-5 @5xl:col-span-5">
        <Skeleton className="aspect-[2/3] w-24 shrink-0 rounded-lg @md:w-32 @2xl:w-40" />
        <div className="flex flex-1 flex-col gap-2 pt-1">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="mt-auto h-1.5 w-full" />
          <Skeleton className="h-10 w-full rounded-lg @md:w-32" />
        </div>
      </div>
      <div className="@container flex min-w-0 flex-col gap-3 @5xl:col-span-7">
        <Skeleton className="h-8 w-28" />
        <ShelfSkeleton />
      </div>
    </div>
  )
}

function AddedSkeleton() {
  return (
    <div role="status" aria-label="Loading library" className="flex flex-col gap-4">
      <Skeleton className="h-8 w-full max-w-sm rounded-lg" />
      <div className="grid grid-cols-3 gap-3 md:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index}>
            <Skeleton className="aspect-[2/3] w-full rounded-lg" />
            <Skeleton className="mt-2 h-3 w-3/4" />
          </div>
        ))}
      </div>
    </div>
  )
}

function HomePending() {
  return (
    <PageContainer>
      <ReadingSkeleton />
    </PageContainer>
  )
}
