import { Link } from '@tanstack/react-router'
import { Heart, ImageOff } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'

import { useGridFavorites } from '@/components/manga/use-grid-favorites'
import type { GridFavorites } from '@/components/manga/use-grid-favorites'
import { warmImages } from '@/lib/images/warm'
import { MangaListRow } from '@/components/manga-list-row'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useLongPress } from '@/lib/use-long-press'
import { VirtualList } from '@/components/virtual-list'
import type { SManga } from '@/lib/sources/types'
import {
  chunkRows,
  useGridColumns,
  useListColumns,
} from '@/lib/virtual/use-grid-columns'
import { useElementWidth } from '@/lib/virtual/use-element-width'
import { usePageVirtualizer } from '@/lib/virtual/use-page-virtualizer'
import { cn } from '@/lib/utils'

/** Sources key a series by a source-relative url; the route wants just the slug. */
export function mangaSlug(manga: SManga): string {
  const memoSlug = manga.memo?.slug
  if (typeof memoSlug === 'string' && memoSlug) return memoSlug
  return manga.url.replace(/^\/series\//, '').replace(/\/$/, '')
}

const GRID_CLASS = 'grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-4 xl:grid-cols-6'

/**
 * One row of a virtualized grid. The vertical gap is the row's own bottom
 * padding rather than the container's `gap-y`, because a virtualized row has
 * to carry the space that follows it inside its own measured height.
 */
const GRID_ROW_CLASS = 'grid grid-cols-2 gap-x-3 sm:grid-cols-4 xl:grid-cols-6'

/** Matches `pb-5` on a row, and the `gap-y-5` of the unvirtualized shell. */
const ROW_GAP = 20

/** Mirrors `useListColumns`, which is what decides how many fit on a row. */
const LIST_ROW_CLASS = 'grid grid-cols-1 gap-x-2 md:grid-cols-2 xl:grid-cols-3'

/**
 * Height of one compact list row, and the gap beneath it.
 *
 * The starting guess only. Rows are measured once mounted, so a drift between
 * this and the `h-18` in `MangaListRow` costs a corrected scrollbar rather
 * than a broken layout — which is what it used to cost, when the gap the row
 * painted and the slot it was given could disagree with nothing to reconcile
 * them.
 */
export const LIST_ROW_HEIGHT = 72
export const LIST_ROW_GAP = 8

/** Which of the two densities a surface is drawing. */
export type MangaLayoutMode = 'grid' | 'list'

/** The bare grid container, for the fixed-length placeholder grid below. */
function MangaGridShell({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={cn(GRID_CLASS, className)}>{children}</div>
}

interface VirtualGridProps<T> {
  items: readonly T[]
  className?: string
  renderCard(item: T, index: number): ReactNode
  /**
   * The item's cover url, when the layout should warm covers ahead of the
   * scroll. Omit and nothing is prefetched.
   */
  coverUrlOf?(item: T): string | undefined
}

interface VirtualLayoutProps<T> extends VirtualGridProps<T> {
  mode: MangaLayoutMode
}

/**
 * How many rows past the last rendered one to fetch covers for.
 *
 * The virtualizer's `overscan` decides how far ahead rows *mount*, and a cover
 * only starts loading when its row does — so at any speed above a slow drag
 * the grid outruns its own images and scrolls over empty tiles. This window
 * runs ahead of the mounted range instead, which is the whole point; matching
 * `overscan` would warm only rows whose images were already requested.
 *
 * Covers are plain image loads and never pass through a source's rate limiter,
 * so unlike a chapter or a series fetch this costs nothing but bandwidth.
 */
const COVER_WARM_ROWS = 4

/**
 * Fetch covers for the rows just below the ones on screen.
 *
 * Keyed off the last rendered row rather than the scroll offset: it changes
 * once per row crossed instead of once per frame, and it is already the number
 * the window is measured from. Every url is requested at most once per `rows`
 * identity, so scrolling back and forth does not re-issue them.
 */
function useCoverWarming<T>(
  rows: readonly (readonly T[])[],
  lastRenderedRow: number,
  coverUrlOf?: (item: T) => string | undefined,
): void {
  const requested = useRef<Set<string>>(new Set())

  useEffect(() => {
    requested.current = new Set()
  }, [rows])

  useEffect(() => {
    if (!coverUrlOf || lastRenderedRow < 0) return

    const last = Math.min(lastRenderedRow + COVER_WARM_ROWS, rows.length - 1)
    const pending: string[] = []

    for (let index = lastRenderedRow + 1; index <= last; index++) {
      for (const item of rows[index] ?? []) {
        const url = coverUrlOf(item)
        if (!url || requested.current.has(url)) continue
        requested.current.add(url)
        pending.push(url)
      }
    }

    warmImages(pending)
  }, [rows, lastRenderedRow, coverUrlOf])
}

/**
 * A row-virtualized manga layout, at either density.
 *
 * Rows rather than cells: the cards are a fixed aspect ratio and sit on a
 * plain CSS grid, so a row is one measurable unit and the browser keeps doing
 * the horizontal layout it is good at. The virtualizer only has to know how
 * tall each row is, and it measures that for real — the estimate below just
 * keeps the scrollbar honest until it does.
 *
 * Both densities are measured. A list row is a fixed height and could be
 * estimated exactly, but its vertical gap is the row's own bottom padding:
 * skip the measurement and the slot is whatever the estimate claimed, so a
 * stale constant silently drops the gap while the horizontal one — a real CSS
 * gap — survives, and the two axes drift apart.
 */
export function VirtualMangaLayout<T>({
  items,
  mode,
  className,
  renderCard,
  coverUrlOf,
}: VirtualLayoutProps<T>) {
  const gridColumns = useGridColumns()
  const listColumns = useListColumns()
  const columns = mode === 'grid' ? gridColumns : listColumns
  const [wrapper, setWrapper] = useState<HTMLDivElement | null>(null)
  const width = useElementWidth(wrapper)

  const rows = useMemo(() => chunkRows(items, columns), [items, columns])
  const rowCount = rows.length

  // Stable while the layout is: the virtualizer drops its measurement cache
  // when an option that decides sizes changes identity.
  const estimateSize = useCallback(
    (index: number) => {
      if (mode === 'list') {
        // The last row carries no trailing gap, exactly as the markup does.
        return LIST_ROW_HEIGHT + (index < rowCount - 1 ? LIST_ROW_GAP : 0)
      }
      return estimateRowHeight(width, columns)
    },
    [mode, rowCount, width, columns],
  )

  const { listRef, virtualizer, scrollMargin } = usePageVirtualizer({
    count: rows.length,
    estimateSize,
    overscan: 3,
  })

  const rendered = virtualizer.getVirtualItems()
  const lastRenderedRow = rendered.length > 0 ? rendered[rendered.length - 1]!.index : -1
  useCoverWarming(rows, lastRenderedRow, coverUrlOf)

  return (
    <div ref={setWrapper} className={className}>
      <VirtualList
        virtualizer={virtualizer}
        listRef={listRef}
        scrollMargin={scrollMargin}
        measure
      >
        {(index) => (
          <div
            className={cn(
              mode === 'grid' ? GRID_ROW_CLASS : LIST_ROW_CLASS,
              // The last row carries no trailing gap, so the list ends where
              // the page's own spacing takes over.
              index < rows.length - 1 && (mode === 'grid' ? 'pb-5' : 'pb-2'),
            )}
          >
            {rows[index]?.map((item, column) =>
              renderCard(item, index * columns + column),
            )}
          </div>
        )}
      </VirtualList>
    </div>
  )
}

/**
 * Height of a row before it has been measured.
 *
 * The cover is `aspect-[2/3]`, so its height follows from the card width; the
 * title below it is `mt-2` and clamped to two lines of `text-[0.8rem]` at
 * `leading-snug`. A guess rather than a promise — rows correct themselves on
 * mount — but a close one keeps the scrollbar from lurching on a long grid.
 */
function estimateRowHeight(width: number, columns: number): number {
  const GAP_X = 12
  const TITLE = 8 + Math.ceil(2 * 0.8 * 16 * 1.375)

  if (width <= 0) return 320
  const card = (width - GAP_X * (columns - 1)) / columns
  return Math.round(card * 1.5 + TITLE + ROW_GAP)
}

export function MangaGrid({
  sourceId,
  mangas,
  compact,
  showCover = true,
  className,
}: {
  sourceId: string
  mangas: SManga[]
  /** The reader's "compact list view" setting: rows instead of cover tiles. */
  compact: boolean
  /**
   * False when the source publishes no covers, which drops the thumbnail
   * column from its rows. Passed down rather than read from the registry here:
   * importing sources into a component would put every scraper back on the
   * shell's critical path, which is what `catalog.ts` exists to avoid.
   */
  showCover?: boolean
  className?: string
}) {
  // One read for the whole grid rather than one per card; see the hook.
  const favorites = useGridFavorites(sourceId)

  return (
    <VirtualMangaLayout
      items={mangas}
      mode={compact ? 'list' : 'grid'}
      className={className}
      coverUrlOf={browseCoverUrl}
      // Keyed with the index too: a source can list the same series on two
      // pages, and infinite scroll only ever appends, so the index is stable.
      renderCard={(manga, index) => {
        const props = { sourceId, manga, favorites }
        return compact ? (
          <MangaBrowseRow
            key={`${manga.url}-${index}`}
            {...props}
            showCover={showCover}
          />
        ) : (
          <MangaCard key={`${manga.url}-${index}`} {...props} />
        )
      }}
    />
  )
}

/** Stable identity: a new function each render would reset the warm set. */
function browseCoverUrl(manga: SManga): string | undefined {
  return manga.thumbnailUrl
}

interface BrowseItemProps {
  sourceId: string
  manga: SManga
  favorites: GridFavorites
}

interface FavoriteGesture {
  inLibrary: boolean
  disabled: boolean
  setFavorite(): void
  hold: ReturnType<typeof useLongPress>
  openSeries(event: ReactMouseEvent): void
}

/**
 * Following as a second gesture on a browse item, at either density.
 *
 * Touch has no hover, so the heart cannot be the only way in: a hold follows
 * the series instead. That hold ends in a click on the link underneath it,
 * which would open the series the hold just followed, so the first click
 * after one is swallowed.
 */
function useFavoriteGesture(
  manga: SManga,
  favorites: GridFavorites,
): FavoriteGesture {
  const inLibrary = favorites.isFavorite(manga.url)
  const disabled = !favorites.ready || favorites.isBusy(manga.url)
  const { toggle } = favorites

  const setFavorite = useCallback(() => {
    if (disabled) return
    toggle(manga, !inLibrary)
  }, [disabled, toggle, manga, inLibrary])

  const heldOpen = useRef(false)

  const hold = useLongPress(() => {
    heldOpen.current = true
    setFavorite()
  }, { disabled })

  const openSeries = useCallback((event: ReactMouseEvent) => {
    if (!heldOpen.current) return
    heldOpen.current = false
    event.preventDefault()
  }, [])

  return { inLibrary, disabled, setFavorite, hold, openSeries }
}

/** The heart's label, which doubles as its tooltip. */
function favoriteLabel(inLibrary: boolean): string {
  return inLibrary ? 'Remove from library' : 'Add to library'
}

/**
 * A pointer affordance only: the heart fades in on hover, on focus, or when
 * the series is already followed, and stays out of the way on touch — which
 * has the hold instead.
 */
const FAVORITE_BUTTON_CLASS =
  'rounded-full border border-border transition-opacity'

const FAVORITE_HIDDEN_CLASS =
  'opacity-0 max-md:hidden group-hover:opacity-100 focus-visible:opacity-100'

/**
 * One cover in the browse grid, with following as a second gesture.
 *
 * The heart is a sibling of the link rather than a child of it — a button
 * inside an anchor is not markup a browser is obliged to make sense of.
 */
function MangaCard({ sourceId, manga, favorites }: BrowseItemProps) {
  const { inLibrary, disabled, setFavorite, hold, openSeries } =
    useFavoriteGesture(manga, favorites)

  return (
    <div
      className="group relative"
      // Otherwise the platform's own press-and-hold menu — save image, open in
      // new tab — surfaces on top of the gesture and eats it.
      onContextMenu={(event) => event.preventDefault()}
    >
      <Link
        to="/manga/$sourceId/$slug"
        params={{ sourceId, slug: mangaSlug(manga) }}
        className="block select-none focus-visible:outline-none [-webkit-touch-callout:none]"
        onClick={openSeries}
        {...hold}
      >
        <MangaCover
          url={manga.thumbnailUrl}
          title={manga.title}
          className="transition-colors group-hover:border-primary/60 group-focus-visible:border-primary"
        />
        <p className="mt-2 line-clamp-2 text-[0.8rem] leading-snug text-foreground/90 transition-colors group-hover:text-foreground">
          {manga.title}
        </p>
      </Link>

      <Button
        type="button"
        variant="secondary"
        size="icon-sm"
        className={cn(
          'absolute top-1.5 right-1.5',
          FAVORITE_BUTTON_CLASS,
          !inLibrary && FAVORITE_HIDDEN_CLASS,
        )}
        disabled={disabled}
        aria-pressed={inLibrary}
        aria-label={favoriteLabel(inLibrary)}
        title={favoriteLabel(inLibrary)}
        onClick={setFavorite}
      >
        <Heart className={inLibrary ? 'fill-current text-primary' : undefined} />
      </Button>
    </div>
  )
}

/**
 * The same series as one line, for the compact list setting.
 *
 * The heart moves to the end of the row and the title reserves room for it,
 * because at this size it would otherwise sit on top of the text rather than
 * over a cover that can spare the corner.
 */
function MangaBrowseRow({
  sourceId,
  manga,
  favorites,
  showCover = true,
}: BrowseItemProps & { showCover?: boolean }) {
  const { inLibrary, disabled, setFavorite, hold, openSeries } =
    useFavoriteGesture(manga, favorites)

  return (
    <div
      className="group relative"
      onContextMenu={(event) => event.preventDefault()}
    >
      <Link
        to="/manga/$sourceId/$slug"
        params={{ sourceId, slug: mangaSlug(manga) }}
        className="block select-none focus-visible:outline-none [-webkit-touch-callout:none]"
        onClick={openSeries}
        {...hold}
      >
        <MangaListRow
          thumbnailUrl={manga.thumbnailUrl}
          title={manga.title}
          showCover={showCover}
          className="pr-9"
          // Nothing to say means no second line at all, exactly as the library
          // rows treat their counts.
          meta={inLibrary ? <span>In library</span> : undefined}
        />
      </Link>

      <Button
        type="button"
        variant="secondary"
        size="icon-sm"
        className={cn(
          // Centred with auto margins rather than `-translate-y-1/2`: the
          // button's own press state is a `translate-y-px`, which would replace
          // the centring transform and drop the heart half a row on every tap.
          'absolute inset-y-0 right-1.5 my-auto',
          FAVORITE_BUTTON_CLASS,
          !inLibrary && FAVORITE_HIDDEN_CLASS,
        )}
        disabled={disabled}
        aria-pressed={inLibrary}
        aria-label={favoriteLabel(inLibrary)}
        title={favoriteLabel(inLibrary)}
        onClick={setFavorite}
      >
        <Heart className={inLibrary ? 'fill-current text-primary' : undefined} />
      </Button>
    </div>
  )
}

export function MangaCover({
  url,
  title,
  className,
}: {
  url?: string
  title: string
  className?: string
}) {
  // The url that failed, rather than a boolean reset by an effect: a card in a
  // virtualized grid mounts every time it scrolls back into view, and an effect
  // that resets on mount costs a second render pass each time.
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const broken = url !== undefined && failedUrl === url

  return (
    <div
      className={cn(
        'relative aspect-[2/3] overflow-hidden rounded-lg border border-border bg-card',
        className,
      )}
    >
      {url && !broken ? (
        <img
          src={url}
          alt={title}
          loading="lazy"
          // The grid scrolls covers in faster than the main thread can decode
          // them; off-thread decoding keeps that work out of the scroll.
          decoding="async"
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
          // A stored cover can outlive its URL — local-source covers are
          // `blob:` URLs that die with the document. Fall back to the
          // placeholder instead of rendering a broken image.
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
          <ImageOff className="size-6" />
        </div>
      )}
    </div>
  )
}

export function MangaGridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <MangaGridShell>
      {Array.from({ length: count }, (_, index) => (
        <div key={index}>
          <Skeleton className="aspect-[2/3] w-full rounded-lg" />
          <Skeleton className="mt-2 h-3 w-4/5" />
        </div>
      ))}
    </MangaGridShell>
  )
}
