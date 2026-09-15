import { cn } from '@/lib/utils'

/**
 * Circular download progress.
 *
 * Drawn in `currentColor` so it takes the colour of whatever button holds it —
 * the reader carries its own palette, and a ring hardcoded to the app tokens
 * would be invisible there.
 */

const RADIUS = 10
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** Arc drawn while the page count is still unknown, as a fraction of the ring. */
const INDETERMINATE_ARC = 0.25

export interface DownloadRingProps {
  value: number
  max: number
  /** No page count yet: spin a fixed arc rather than sit at zero. */
  indeterminate?: boolean
  /** Draws a stop square inside the ring, for a ring that can be cancelled. */
  stop?: boolean
  label: string
  className?: string
}

export function DownloadRing({
  value,
  max,
  indeterminate = false,
  stop = false,
  label,
  className,
}: DownloadRingProps) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
  const drawn = indeterminate ? INDETERMINATE_ARC : ratio

  return (
    <svg
      viewBox="0 0 24 24"
      className={cn('size-5', indeterminate && 'animate-spin', className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={indeterminate ? undefined : max}
      aria-valuenow={indeterminate ? undefined : value}
      aria-valuetext={label}
    >
      <circle
        cx="12"
        cy="12"
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        className="opacity-25"
      />
      <circle
        cx="12"
        cy="12"
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${CIRCUMFERENCE * drawn} ${CIRCUMFERENCE}`}
        // Start at twelve o'clock rather than three.
        transform="rotate(-90 12 12)"
        className={indeterminate ? undefined : 'transition-[stroke-dasharray]'}
      />
      {/* Left off while the ring spins: a square turning with it reads as noise
          rather than as a stop. */}
      {stop && !indeterminate && (
        <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" />
      )}
    </svg>
  )
}
