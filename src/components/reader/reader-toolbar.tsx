import type { ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'

import { Progress } from '@/components/ui/progress'

interface ReaderToolbarProps {
  title: string
  /** The chapter, and its group where the source names one. */
  subtitle: string
  /** How far through the chapter, 0–100. Null before the length is known. */
  progressPercent: number | null
  onExit(): void
  /** Trailing controls about this chapter, such as saving it offline. */
  actions?: ReactNode
}

/**
 * The reader's title bar: what is being read, and the controls about the
 * chapter itself. Moving through it lives in the floating bar at the bottom.
 *
 * It floats over the page rather than sitting above it, so hiding it while
 * reading costs the chapter no reflow. Hence the translucent background: what
 * passes underneath has to stay readable.
 */
export function ReaderToolbar({
  title,
  subtitle,
  progressPercent,
  onExit,
  actions,
}: ReaderToolbarProps) {
  return (
    <header className="relative border-b border-border bg-card/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-1 px-1.5 md:px-3">
        <button
          type="button"
          onClick={onExit}
          aria-label="Back to series"
          title="Back to series (Esc)"
          className="flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <ChevronLeft aria-hidden className="size-5" />
        </button>

        {/* Left-aligned beside Back rather than centred, so a long title has the
            whole bar to truncate into. */}
        <div className="min-w-0 flex-1 px-1">
          <span className="block truncate text-sm font-medium text-card-foreground">
            {title}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
        </div>

        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>

      {/* Sits on the bar's own bottom edge, so it reads as the boundary line
          filling in rather than as another element competing for height. */}
      {progressPercent === null ? null : (
        <Progress
          value={progressPercent}
          aria-label="Reading progress"
          className="absolute inset-x-0 -bottom-px h-0.5 rounded-none bg-transparent [&>[data-slot=progress-indicator]]:bg-primary"
        />
      )}
    </header>
  )
}
