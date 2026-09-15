import { useCallback, useSyncExternalStore } from 'react'

interface ColumnBreakpoint {
  query: string
  columns: number
}

/**
 * How many cards the manga grid puts on a row, at each of its breakpoints.
 *
 * These mirror `grid-cols-2 sm:grid-cols-4 xl:grid-cols-6` in `manga-grid.tsx`
 * and Tailwind's stock `sm` and `xl`. The grid's classes are viewport media
 * queries, so `matchMedia` resolves them exactly as the stylesheet does —
 * including the rem-to-px conversion, which a container measurement would get
 * wrong the moment the root font size is not 16px.
 */
const GRID_BREAKPOINTS: readonly ColumnBreakpoint[] = [
  { query: '(min-width: 80rem)', columns: 6 },
  { query: '(min-width: 40rem)', columns: 4 },
]

const GRID_BASE_COLUMNS = 2

/**
 * The compact list's columns, mirroring `md:grid-cols-2 xl:grid-cols-3`.
 *
 * A list row is short and wide, so a phone gets one and a desk gets three —
 * the point of the mode is seeing more titles at once, not narrower rows.
 */
const LIST_BREAKPOINTS: readonly ColumnBreakpoint[] = [
  { query: '(min-width: 80rem)', columns: 3 },
  { query: '(min-width: 48rem)', columns: 2 },
]

const LIST_BASE_COLUMNS = 1

/** Ordered widest-first, so the first match is the one the stylesheet applies. */
function useResponsiveColumns(
  breakpoints: readonly ColumnBreakpoint[],
  base: number,
): number {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const lists = breakpoints.map(({ query }) => window.matchMedia(query))
      for (const list of lists) list.addEventListener('change', onChange)
      return () => {
        for (const list of lists) list.removeEventListener('change', onChange)
      }
    },
    [breakpoints],
  )

  const read = useCallback(() => {
    if (typeof window === 'undefined') return base
    for (const { query, columns } of breakpoints) {
      if (window.matchMedia(query).matches) return columns
    }
    return base
  }, [breakpoints, base])

  return useSyncExternalStore(subscribe, read, () => base)
}

export function useGridColumns(): number {
  return useResponsiveColumns(GRID_BREAKPOINTS, GRID_BASE_COLUMNS)
}

export function useListColumns(): number {
  return useResponsiveColumns(LIST_BREAKPOINTS, LIST_BASE_COLUMNS)
}

/** Splits a flat list into rows of `columns`, for a row-virtualized grid. */
export function chunkRows<T>(items: readonly T[], columns: number): T[][] {
  const rows: T[][] = []
  for (let index = 0; index < items.length; index += columns) {
    rows.push(items.slice(index, index + columns))
  }
  return rows
}
