import { ChevronLeft } from 'lucide-react'

import { Progress } from '@/components/ui/progress'

interface ReaderToolbarProps {
  title: string
  chapterName: string
  pageIndicator: string
  /** How far through the chapter, 0–100. Null before the length is known. */
  progressPercent: number | null
  onExit(): void
}

/**
 * The reader's title bar, and nothing else.
 *
 * Every control the reader acts on lives in the floating bar at the bottom, so
 * all this carries is what is being read, where it centres the eye, plus how
 * far in you are.
 *
 * It floats over the page rather than sitting above it, so hiding it while
 * reading costs the chapter no reflow. Hence the translucent background: what
 * passes underneath has to stay readable.
 */
export function ReaderToolbar({
  title,
  chapterName,
  pageIndicator,
  progressPercent,
  onExit,
}: ReaderToolbarProps) {
  return (
    <header className="relative flex h-12 w-full items-center border-b border-border bg-card/90 px-3 backdrop-blur">
      {/* Anchored to the bar's left edge, on its own, so nothing can crowd it. */}
      <button
        type="button"
        onClick={onExit}
        aria-label="Back to series"
        title="Back to series (Esc)"
        className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <ChevronLeft aria-hidden className="size-4" />
      </button>

      {/* Centred against the full bar, with insets that clear the back button
          and the counter so the title truncates instead of overlapping them. */}
      <div className="pointer-events-none absolute inset-x-16 top-1/2 -translate-y-1/2 text-center">
        <span className="block truncate text-sm font-medium text-card-foreground">
          {title}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {chapterName}
        </span>
      </div>

      {/* Out of the centred flow, so the title stays centred against the full
          bar rather than against the space the counter leaves over. */}
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 tabular-nums text-xs text-muted-foreground">
        {pageIndicator}
      </span>

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
