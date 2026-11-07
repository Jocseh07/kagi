import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { BookOpen, Play } from 'lucide-react'

import { chapterKeyOf } from '@/components/updates/format'
import { Spinner } from '@/components/ui/spinner'
import type { ReadTarget } from '@/lib/db/home'
import { cn } from '@/lib/utils'

export interface SeriesParams {
  sourceId: string
  slug: string
}

const ROUND =
  'absolute right-1.5 bottom-2.5 z-10 flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md transition-[background-color,scale] duration-150 hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-95 disabled:pointer-events-none motion-reduce:transition-none motion-reduce:active:scale-100'

/**
 * The round button on a cover: reads, where the tile itself opens the series.
 * Either a known chapter (`link`), or one looked up on tap (`resolve`), which
 * falls back to the series page when the series has nothing to open.
 */
export function ReadButton({
  label,
  icon = 'play',
  series,
  link,
  resolve,
}: {
  label: string
  icon?: 'play' | 'saved'
  series: SeriesParams
  link?: { chapter: string }
  resolve?: () => Promise<ReadTarget | null>
}) {
  const navigate = useNavigate()
  const [pending, setPending] = useState(false)
  const Icon = icon === 'saved' ? BookOpen : Play
  const glyph = <Icon aria-hidden className={cn('size-4', icon === 'play' && 'fill-current')} />

  if (link) {
    return (
      <Link
        to="/reader/$sourceId/$slug/$chapter"
        params={{ ...series, chapter: link.chapter }}
        aria-label={label}
        title={label}
        className={ROUND}
      >
        {glyph}
      </Link>
    )
  }

  const open = async () => {
    if (!resolve) return
    setPending(true)
    try {
      const target = await resolve()
      if (target) {
        await navigate({
          to: '/reader/$sourceId/$slug/$chapter',
          params: { ...series, chapter: chapterKeyOf(target.url, target.chapterNumber) },
        })
      } else {
        await navigate({ to: '/manga/$sourceId/$slug', params: series })
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-busy={pending || undefined}
      disabled={pending}
      onClick={() => void open()}
      className={ROUND}
    >
      {pending ? <Spinner size="sm" /> : glyph}
    </button>
  )
}
