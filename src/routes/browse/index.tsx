import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { BookText, ChevronRight, CloudOff, HardDrive, Library } from 'lucide-react'
import { useState } from 'react'

import { KindTabs, kindTabOf } from '@/components/kind-tabs'
import type { KindTab } from '@/components/kind-tabs'
import { LocalFolderPicker } from '@/components/local/folder-picker'
import { PageContainer } from '@/components/page-container'
import { ContentRatingBadge } from '@/components/sources/content-rating-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { useOnline } from '@/lib/offline/use-online'
import { useHideAdultSources } from '@/lib/sources/adult'
import { listSources } from '@/lib/sources/registry'
import { isAdultRated, kindOf } from '@/lib/sources/types'
import type { ContentKind, Source } from '@/lib/sources/types'

/** What the page is showing. Absent means every kind. */
interface BrowseSearch {
  kind?: ContentKind
}

export const Route = createFileRoute('/browse/')({
  validateSearch: (search: Record<string, unknown>): BrowseSearch => {
    const kind = kindTabOf(search.kind)
    return kind ? { kind } : {}
  },
  component: BrowseIndex,
})

function BrowseIndex() {
  const online = useOnline()
  const hideAdult = useHideAdultSources()

  const { kind } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

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
    void navigate({
      search: () => (next === 'all' ? {} : { kind: next }),
    })
  }

  return (
    <PageContainer>
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Browse</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {visible.length} source{visible.length === 1 ? '' : 's'} installed.
          {hidden > 0 && ` ${hidden} hidden.`}
        </p>
      </header>

      <KindTabs
        label="Source type"
        value={kind ?? 'all'}
        counts={counts}
        onChange={applyKind}
      />

      {sources.length === 0 ? (
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
              {/* Both local sources read the same folder, so the picker sits
                  under the group rather than on one of the cards — and stays
                  there on a kind tab, where only one of them is shown. They
                  are unusable until a folder is chosen, so the choice belongs
                  where they are found. */}
              <LocalFolderPicker />
            </div>
          )}
        </>
      )}
    </PageContainer>
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
