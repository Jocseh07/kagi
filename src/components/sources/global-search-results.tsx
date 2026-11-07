/**
 * One query, every source: the Browse box asks each installed source at the
 * same time and gives each its own row.
 *
 * Deliberately not merged into a single grid. A reader searching across
 * sources is asking "who has this?", and an interleaved list answers it worse
 * than fifteen labelled rows do. Rows also mean each source carries its own
 * loading, empty and error state, so the slow one does not hold up the fast
 * one and the broken one does not take the page down with it.
 */

import { Link } from '@tanstack/react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'

import { MangaCard, MangaCover } from '@/components/manga-grid'
import { ContentRatingBadge } from '@/components/sources/content-rating-badge'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorPanel } from '@/components/ui/error-panel'
import { useGridFavorites } from '@/components/manga/use-grid-favorites'
import type { SManga, Source } from '@/lib/sources/types'
import { cn } from '@/lib/utils'

/** How much of a source's first page a rail shows before "See all" takes over. */
const RAIL_LIMIT = 12

/** Matches `RAIL_LIMIT`'s visual weight while the request is out. */
const SKELETON_COUNT = 6

const CARD_WIDTH = 'w-28 shrink-0 sm:w-32'

/**
 * Picking instead of opening.
 *
 * The migrate screen shows the same rails, but a card there is a choice being
 * made rather than a series being opened — so it becomes a button, and the
 * links out of the row go with it.
 */
export type PickHandler = (source: Source, manga: SManga) => void

export function GlobalSearchResults({
  sources,
  query,
  onPick,
}: {
  sources: Source[]
  query: string
  onPick?: PickHandler
}) {
  return (
    <div className="flex flex-col gap-page">
      {sources.map((source) => (
        <SourceSearchRail
          key={source.id}
          source={source}
          query={query}
          onPick={onPick}
        />
      ))}
    </div>
  )
}

function SourceSearchRail({
  source,
  query,
  onPick,
}: {
  source: Source
  query: string
  onPick?: PickHandler
}) {
  // One read for the whole rail rather than one per card, same as the grid.
  const favorites = useGridFavorites(source.id)

  const results = useQuery({
    queryKey: ['global-search', source.id, query],
    // The source's own defaults: only the source page knows how to fetch and
    // edit a filter list, and there is no vocabulary shared across sources to
    // apply one here.
    queryFn: ({ signal }) =>
      source.getSearchMangaList(1, query, source.getFilterList(), signal),
    staleTime: 5 * 60_000,
    // Fifteen sources are in flight at once; one source retrying forever
    // would keep its row spinning long after the others had answered.
    retry: 1,
    placeholderData: keepPreviousData,
  })

  const mangas = results.data?.mangas.slice(0, RAIL_LIMIT) ?? []

  return (
    <section className="flex flex-col gap-2">
      <header className="flex items-center gap-2">
        <h2 className="truncate text-sm font-medium">{source.name}</h2>
        <ContentRatingBadge rating={source.contentRating} />
        {/* Offered as soon as the source has answered, results or not: a rail
            that failed or came back short is exactly when opening the source
            itself is worth doing. */}
        {!results.isPending && !onPick && (
          <Link
            to="/browse/$sourceId"
            params={{ sourceId: source.id }}
            search={{ tab: 'search' as const, q: query }}
            className="ml-auto flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            See all
            <ChevronRight className="size-3.5" />
          </Link>
        )}
      </header>

      {results.isPending ? (
        <RailSkeleton />
      ) : results.isError ? (
        <ErrorPanel error={results.error} onRetry={() => void results.refetch()} />
      ) : mangas.length === 0 ? (
        <p className="text-sm text-muted-foreground">No matches.</p>
      ) : (
        <ul
          aria-busy={results.isPlaceholderData}
          className={cn(
            'bleed-page -my-1 flex gap-3 overflow-x-auto py-1 transition-opacity motion-reduce:transition-none',
            results.isPlaceholderData && 'opacity-60',
          )}
        >
          {mangas.map((manga, index) => (
            <li key={`${manga.url}-${index}`} className={CARD_WIDTH}>
              {onPick ? (
                <PickCard
                  manga={manga}
                  onPick={() => onPick(source, manga)}
                />
              ) : (
                <MangaCard
                  sourceId={source.id}
                  manga={manga}
                  favorites={favorites}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * The same cover and title, as a button.
 *
 * No heart and no hold: the one gesture this card has is the choice the screen
 * exists to make, and offering a second one on a series the reader has not
 * decided on yet would be a way to follow something by accident.
 */
function PickCard({ manga, onPick }: { manga: SManga; onPick(): void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="group block w-full text-left focus-visible:outline-none"
    >
      <MangaCover
        url={manga.thumbnailUrl}
        className="transition-colors group-hover:border-primary/60 group-focus-visible:border-primary"
      />
      <p className="mt-2 line-clamp-2 text-tile leading-snug text-foreground/90 transition-colors group-hover:text-foreground">
        {manga.title}
      </p>
    </button>
  )
}

function RailSkeleton() {
  return (
    <div className="bleed-page flex gap-3 overflow-hidden" aria-hidden>
      {Array.from({ length: SKELETON_COUNT }, (_, index) => (
        <div key={index} className={CARD_WIDTH}>
          <Skeleton className="aspect-[2/3] w-full rounded-lg" />
          <Skeleton className="mt-2 h-3 w-4/5 rounded-md" />
        </div>
      ))}
    </div>
  )
}
