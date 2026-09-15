/**
 * The 18+ tag on a source, wherever that source is named.
 *
 * Two tags rather than one: an adult catalogue and a general catalogue that
 * also carries adult work are different facts, and a reader deciding whether
 * to open MangaDex is not being told the same thing as one opening Toonily.
 * A safe source gets nothing at all — a "safe" tag on ten of fifteen rows is
 * noise, and the absence of a tag already says it.
 */

import { Badge } from '@/components/ui/badge'
import type { ContentRating } from '@/lib/sources/types'

export function ContentRatingBadge({ rating }: { rating: ContentRating }) {
  if (rating === 'safe') return null

  return rating === 'adult' ? (
    <Badge variant="destructive" className="shrink-0">
      18+
    </Badge>
  ) : (
    <Badge variant="secondary" className="shrink-0">
      Some 18+
    </Badge>
  )
}
