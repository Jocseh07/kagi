/**
 * The title to show for a series. A title that is empty or is the slug itself
 * reads as words, with any trailing numeric id dropped.
 */
export function displayTitle(title: string, slug: string): string {
  const trimmed = title.trim()
  if (trimmed && trimmed !== slug) return trimmed

  const words = slug
    .replace(/[_-]\d{6,}$/, '')
    .replace(/[-_]+/g, ' ')
    .trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
