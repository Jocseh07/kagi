import { useEffect, useState } from 'react'
import { useRouterState } from '@tanstack/react-router'

import { Progress } from '@/components/ui/progress'

/** How far the trickle is allowed to creep while the route is still pending. */
const CEILING = 90

/** Milliseconds between trickle steps. */
const TICK = 200

/** Matches the bar's transition duration, so the reset lands after it plays. */
const FADE = 200

/**
 * The thin bar across the top of the window while a route is loading.
 *
 * Routes that resolve without a loader never enter `pending`, so the bar simply
 * never appears for them — the signal is reserved for waits worth reporting.
 */
export function NavigationProgress() {
  // Selector form on purpose: the router publishes state on far more than
  // status changes, and this mounts in the root layout.
  const status = useRouterState({ select: (state) => state.status })

  const [progress, setProgress] = useState(0)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (status === 'pending') {
      setVisible(true)
      setProgress(10)

      // Decaying step: fast off the mark where the wait is most likely to end,
      // then slower, approaching the ceiling without ever claiming to be done.
      const timer = setInterval(() => {
        setProgress((current) => current + (CEILING - current) * 0.1)
      }, TICK)

      return () => clearInterval(timer)
    }

    setProgress(100)
    const timer = setTimeout(() => {
      setVisible(false)
      setProgress(0)
    }, FADE)

    return () => clearTimeout(timer)
  }, [status])

  if (!visible) return null

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5"
    >
      {/* Trackless on purpose: an unfilled sliver across the top of every
          window would read as chrome rather than as a wait, so the shared
          component's track is cleared and only the indicator shows. */}
      <Progress
        value={progress}
        className="h-full rounded-none bg-transparent [&>[data-slot=progress-indicator]]:shadow-[0_0_8px_1px_var(--primary)] [&>[data-slot=progress-indicator]]:duration-200 [&>[data-slot=progress-indicator]]:ease-out"
      />
    </div>
  )
}
