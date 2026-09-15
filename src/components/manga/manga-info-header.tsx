import {
  Ban,
  Brush,
  Check,
  CheckCheck,
  CircleDollarSign,
  Clock,
  Pause,
  User,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Link } from '@tanstack/react-router'

import { MangaCover } from '@/components/manga-grid'
import type { PageBack } from '@/components/page-back'
import { Button } from '@/components/ui/button'
import type { MangaStatus, SManga } from '@/lib/sources/types'

const STATUS_LABELS: Record<MangaStatus, string> = {
  unknown: 'Unknown',
  ongoing: 'Ongoing',
  completed: 'Completed',
  licensed: 'Licensed',
  publishing_finished: 'Publishing finished',
  cancelled: 'Cancelled',
  on_hiatus: 'On hiatus',
}

/**
 * A mark per publication state, so "ongoing" and "finished" can be told apart
 * at a glance rather than by reading. Mirrors Mihon's mapping with the nearest
 * icon this project's set offers.
 */
const STATUS_ICONS: Record<MangaStatus, LucideIcon> = {
  ongoing: Clock,
  completed: CheckCheck,
  licensed: CircleDollarSign,
  publishing_finished: Check,
  cancelled: X,
  on_hiatus: Pause,
  unknown: Ban,
}

/**
 * Cover, title and the facts about a series.
 *
 * Each fact gets its own line with its own icon rather than being dot-joined
 * into one grey run: an author and an artist are different people, and a
 * publication status is not a genre. On a phone the cover sits to the left of
 * the text; from `md` up this becomes the head of a narrow side rail, so it
 * stacks and the cover takes the rail's full width.
 *
 * From `md` up the way back to the source rides on top of the cover as an
 * outline button: it costs the page no row of its own and sits next to the
 * thing you came for. Below `md` the app header carries it instead.
 *
 * A series already in the library is marked on the cover itself — a step up
 * the radius scale and a primary ring — rather than with a label pinned over
 * the art. The ring is offset from the cover rather than drawn on its edge so
 * that it reads against the background instead of against whatever the art
 * happens to be, which is the only version of this that survives a theme
 * whose primary sits close to a dark cover. The favourite button below still
 * spells the state out in words, which is where the convention is learned.
 */
export function MangaInfoHeader({
  manga,
  sourceName,
  back,
  inLibrary = false,
}: {
  manga: SManga
  sourceName: string
  back?: PageBack
  /** Whether this series is favourited, drawn on the cover. */
  inLibrary?: boolean
}) {
  const StatusIcon = STATUS_ICONS[manga.status]
  const artist =
    manga.artist && manga.artist !== manga.author ? manga.artist : null

  return (
    <div className="flex gap-4 md:flex-col md:gap-3">
      <div className="relative w-28 shrink-0 sm:w-32 md:w-full">
        <MangaCover
          url={manga.thumbnailUrl}
          title={manga.title}
          className={
            inLibrary
              ? 'rounded-xl ring-1 ring-primary/50 ring-offset-2 ring-offset-background'
              : undefined
          }
        />
        {/* The cover treatment is the whole cue, and a cue that is only a
            colour and a corner is no cue at all without sight. */}
        {inLibrary && <span className="sr-only">In library</span>}

        {back && (
          <Button
            asChild
            size="sm"
            className="absolute top-2 left-2 z-10 max-w-[calc(100%-1rem)] shadow-sm max-md:hidden"
          >
            <Link to={back.to} params={back.params}>
              <span className="truncate">{back.label}</span>
            </Link>
          </Button>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight text-balance sm:text-2xl md:text-xl">
          {manga.title}
        </h1>

        <InfoLine icon={User} text={manga.author || 'Unknown author'} />
        {artist && <InfoLine icon={Brush} text={artist} />}

        <div className="flex min-w-0 items-start gap-1.5 text-base text-muted-foreground sm:text-sm">
          <StatusIcon className="size-4 h-lh shrink-0" />
          <p className="min-w-0 truncate">
            {STATUS_LABELS[manga.status]}
            <span className="px-1.5">·</span>
            {sourceName}
          </p>
        </div>
      </div>
    </div>
  )
}

/** One icon-led fact. The icon aligns to the first line, never the block. */
function InfoLine({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="flex min-w-0 items-start gap-1.5 text-base text-muted-foreground sm:text-sm">
      <Icon className="size-4 h-lh shrink-0" />
      <p className="min-w-0 truncate">{text}</p>
    </div>
  )
}
