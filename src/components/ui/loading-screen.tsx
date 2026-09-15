import { useEffect, useState } from 'react'

import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

/**
 * How long a wait has to last before it is worth showing. Below this the
 * spinner would appear and vanish inside a single blink, which reads as a
 * flicker rather than as progress.
 */
const REVEAL_MS = 150

export interface LoadingScreenProps {
  /** Announced to assistive tech, and shown under the spinner when `showLabel`. */
  label?: string
  showLabel?: boolean
  /** Milliseconds to stay blank before revealing. */
  delayMs?: number
  className?: string
}

/**
 * The centred wait that fills whatever region it is dropped into.
 *
 * `min-h-full` rather than `h-full`: this renders both inside the scrolling
 * `<main>` of the root layout (a flex child with a definite height) and, on
 * occasion, directly under a plain block parent. `min-h-full` centres in the
 * first case and still reserves the region in the second.
 */
export function LoadingScreen({
  label = 'Loading',
  showLabel = false,
  delayMs = REVEAL_MS,
  className,
}: LoadingScreenProps) {
  const [visible, setVisible] = useState(delayMs === 0)

  useEffect(() => {
    if (delayMs === 0) return
    const timer = setTimeout(() => setVisible(true), delayMs)
    return () => clearTimeout(timer)
  }, [delayMs])

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy
      className={cn(
        'flex min-h-full flex-1 flex-col items-center justify-center gap-3 p-6',
        className,
      )}
    >
      {visible && (
        <>
          <Spinner size="lg" className="text-muted-foreground" />
          <span
            className={cn(
              'text-sm text-muted-foreground',
              !showLabel && 'sr-only',
            )}
          >
            {label}
          </span>
        </>
      )}
    </div>
  )
}
