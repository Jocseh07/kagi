import { mangaSlug } from '@/components/manga-grid'

/** The route slug of a stored series row. */
export function seriesSlug(
  url: string,
  title: string,
  memo: Record<string, unknown> | null,
): string {
  return mangaSlug({
    url,
    title,
    status: 'unknown',
    initialized: true,
    memo: memo ?? undefined,
  })
}

/** A count on one locale's grouping, for chapter numbers and totals. */
export function formatCount(value: number): string {
  return value.toLocaleString()
}
