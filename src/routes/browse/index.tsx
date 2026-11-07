import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  BookText,
  ChevronRight,
  CloudOff,
  HardDrive,
  Library,
  Search,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { KindTabs, kindTabOf } from '@/components/kind-tabs'
import type { KindTab } from '@/components/kind-tabs'
import { LocalFolderPicker } from '@/components/local/folder-picker'
import { NovelImporter } from '@/components/local/novel-importer'
import { PageContainer } from '@/components/page-container'
import { ContentRatingBadge } from '@/components/sources/content-rating-badge'
import { GlobalSearchResults } from '@/components/sources/global-search-results'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useOnline } from '@/lib/offline/use-online'
import { useHideAdultSources } from '@/lib/sources/adult'
import { listSources } from '@/lib/sources/registry'
import { LOCAL_SOURCE_ID } from '@/lib/sources/local'
import { LOCAL_NOVEL_SOURCE_ID } from '@/lib/sources/local-novel'
import { isAdultRated, kindOf } from '@/lib/sources/types'
import { useDebounced } from '@/lib/use-debounced'
import type { ContentKind, Source } from '@/lib/sources/types'

/** What the page is showing. Absent means every kind, and no search. */
interface BrowseSearch {
  kind?: ContentKind
  /** A term to put to every visible source at once. */
  q?: string
}

export const Route = createFileRoute('/browse/')({
  validateSearch: (search: Record<string, unknown>): BrowseSearch => {
    const next: BrowseSearch = {}

    const kind = kindTabOf(search.kind)
    if (kind) next.kind = kind

    if (typeof search.q === 'string' && search.q.trim()) next.q = search.q

    return next
  },
  component: BrowseIndex,
  pendingComponent: BrowsePending,
})

function BrowseIndex() {
  const online = useOnline()
  const hideAdult = useHideAdultSources()

  const { kind, q } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const query = q ?? ''

  // The same two-way sync the source page uses: the box stays local so typing
  // is immediate, and the URL catches up on a debounce, replacing rather than
  // pushing so Back does not walk back through single letters.
  const [rawQuery, setRawQuery] = useState(query)
  const debouncedQuery = useDebounced(rawQuery, 400)
  const syncedQuery = useRef(query)

  useEffect(() => {
    if (debouncedQuery === syncedQuery.current) return
    syncedQuery.current = debouncedQuery
    void navigate({
      search: (prev) => ({
        ...prev,
        q: debouncedQuery.trim() ? debouncedQuery : undefined,
      }),
      replace: true,
    })
  }, [debouncedQuery, navigate])

  // Back, forward, or a link arriving with a term already on it.
  useEffect(() => {
    if (query === syncedQuery.current) return
    syncedQuery.current = query
    setRawQuery(query)
  }, [query])

  // Local sources read the device, so nothing rates them; the filter only ever
  // reaches the remote list. Counted rather than silently dropped, because a
  // grid that is short by five with no explanation reads as a bug.
  const installed = listSources()
  const visible = hideAdult
    ? installed.filter((source) => !isAdultRated(source))
    : installed
  const hidden = installed.length - visible.length

  // Counted off the adult-filtered list, so a tab's number is what that tab
  // actually shows rather than what is registered.
  const counts: Record<KindTab, number> = {
    all: visible.length,
    comic: visible.filter((source) => kindOf(source) === 'comic').length,
    novel: visible.filter((source) => kindOf(source) === 'novel').length,
  }

  const sources = kind
    ? visible.filter((source) => kindOf(source) === kind)
    : visible
  const remote = sources.filter((source) => !source.isLocal)
  const local = sources.filter((source) => source.isLocal)

  function applyKind(next: KindTab) {
    // The term survives the tab: narrowing to novels mid-search is a way of
    // asking the same question of fewer sources, not a way of starting over.
    void navigate({
      search: (prev) => ({ q: prev.q, ...(next === 'all' ? {} : { kind: next }) }),
    })
  }

  return (
    <PageContainer>
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Browse</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {query
            ? `Searching ${remote.length} source${remote.length === 1 ? '' : 's'}.`
            : `${visible.length} source${visible.length === 1 ? '' : 's'} installed.`}
          {hidden > 0 && ` ${hidden} hidden.`}
        </p>
      </header>

      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={rawQuery}
          onChange={(event) => setRawQuery(event.target.value)}
          placeholder="Search all sources"
          aria-label="Search all sources"
          className="pl-8"
        />
      </div>

      <KindTabs
        label="Source type"
        value={kind ?? 'all'}
        counts={counts}
        onChange={applyKind}
      />

      {query ? (
        // Every source a global search reaches is remote, so without a
        // connection there is nothing to ask.
        !online ? (
          <OfflinePanel />
        ) : remote.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No sources to search on this tab.
          </p>
        ) : (
          <GlobalSearchResults sources={remote} query={query} />
        )
      ) : sources.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {kind === 'novel'
            ? 'No novel sources installed.'
            : kind === 'comic'
              ? 'No comic sources installed.'
              : 'No sources installed.'}
        </p>
      ) : (
        <>
          {/* Every remote source is a dead link without a connection, so the
              grid gives way rather than offering a page of them. Local
              sources read from the device and are left exactly as they are. */}
          {remote.length > 0 &&
            (online ? (
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {remote.map((source) => (
                  <li key={source.id}>
                    <SourceCard source={source} />
                  </li>
                ))}
              </ul>
            ) : (
              <OfflinePanel />
            ))}

          {local.length > 0 && (
            <div className="space-y-3">
              <ul className="grid gap-3 sm:grid-cols-2">
                {local.map((source) => (
                  <li key={source.id}>
                    <SourceCard source={source} />
                  </li>
                ))}
              </ul>
              {/* The two local sources no longer share a store: comics read a
                  folder, novels are imported into this browser. Each gets its
                  own control, and on a kind tab only one of them is shown. */}
              {local.some((source) => source.id === LOCAL_SOURCE_ID) && (
                <LocalFolderPicker />
              )}
              {local.some((source) => source.id === LOCAL_NOVEL_SOURCE_ID) && (
                <NovelImporter />
              )}
            </div>
          )}
        </>
      )}
    </PageContainer>
  )
}

/** The route's shape while its chunk loads; the heading is a constant. */
function BrowsePending() {
  return (
    <PageContainer>
      <h1 className="text-xl font-semibold tracking-tight">Browse</h1>
      <Skeleton className="h-8 w-full rounded-lg" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-16 rounded-lg" />
        ))}
      </div>
    </PageContainer>
  )
}

/** What stands in for the remote sources, whether listed or searched. */
function OfflinePanel() {
  return (
    <EmptyState
      icon={CloudOff}
      title="Sources need a connection"
      description="Everything you have already downloaded is in your library."
      action={
        <Button asChild size="sm">
          <Link to="/library">Go to library</Link>
        </Button>
      }
    />
  )
}

function SourceCard({ source }: { source: Source }) {
  return (
    <Link
      to="/browse/$sourceId"
      params={{ sourceId: source.id }}
      className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary/60 hover:bg-secondary"
    >
      <SourceIcon source={source} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{source.name}</span>
          {/* Novels read in a different viewer and save as text rather than
              images, which is worth knowing before opening the source. */}
          {kindOf(source) === 'novel' && (
            <Badge variant="secondary" className="shrink-0">
              Novels
            </Badge>
          )}
          <ContentRatingBadge rating={source.contentRating} />
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {source.isLocal
            ? 'Files on this device'
            : languageName(source.lang)}
        </p>
      </div>

      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  )
}

function SourceIcon({ source }: { source: Source }) {
  // A source's icon is fetched from the source's own origin, so it can start
  // failing without anything here changing. Falling back to the glyph keeps
  // that from rendering as the browser's broken-image box.
  const [iconFailed, setIconFailed] = useState(false)

  if (source.iconUrl && !iconFailed) {
    return (
      <img
        src={source.iconUrl}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setIconFailed(true)}
        className="size-10 shrink-0 rounded-md border border-border object-contain"
      />
    )
  }

  const Icon = source.isLocal
    ? HardDrive
    : kindOf(source) === 'novel'
      ? BookText
      : Library

  return (
    <div className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground">
      <Icon className="size-5" />
    </div>
  )
}

function languageName(lang: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: 'language' }).of(lang) ?? lang
  } catch {
    return lang
  }
}
