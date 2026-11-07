import { useEffect, useState } from 'react'

import { acquireWakeLock, releaseWakeLock } from '@/lib/download/wake-lock'

import { DIM_AFTER_MS } from '@/lib/reader/reader-settings'

/** Anything that counts as still reading. Capture phase, so viewers cannot eat it. */
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'scroll', 'touchmove'] as const

/**
 * The reader's idle screen behaviour.
 *
 * Keeps the screen awake while the chapter is being read, and fades the page
 * down after a stretch with no touch. Fading down also lets go of the wake
 * lock, so a phone left face-up locks on its own schedule; the next touch
 * brings the page back and takes the lock again.
 */
export function useIdleDimScreen(enabled: boolean): { dimmed: boolean } {
  const [dimmed, setDimmed] = useState(false)

  useEffect(() => {
    if (!enabled) return

    let timer = 0
    let isDimmed = false

    const dim = () => {
      timer = 0
      isDimmed = true
      setDimmed(true)
      void releaseWakeLock()
    }

    const arm = () => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(dim, DIM_AFTER_MS)
    }

    // The touch that wakes a dimmed page is for waking it, not for whatever
    // sits underneath: the click it turns into is swallowed once, so it cannot
    // toggle the chrome or turn a page.
    const swallowClick = (event: Event) => {
      event.stopPropagation()
      document.removeEventListener('click', swallowClick, true)
    }

    const wake = (event?: Event) => {
      if (isDimmed) {
        isDimmed = false
        setDimmed(false)
        if (event?.type === 'pointerdown') {
          document.addEventListener('click', swallowClick, true)
        }
      }
      if (document.visibilityState === 'visible') void acquireWakeLock()
      arm()
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !isDimmed) {
        void acquireWakeLock()
      }
    }

    for (const type of ACTIVITY_EVENTS) {
      document.addEventListener(type, wake, { capture: true, passive: true })
    }
    document.addEventListener('visibilitychange', onVisibility)
    wake()

    return () => {
      for (const type of ACTIVITY_EVENTS) {
        document.removeEventListener(type, wake, { capture: true })
      }
      document.removeEventListener('visibilitychange', onVisibility)
      document.removeEventListener('click', swallowClick, true)
      if (timer) window.clearTimeout(timer)
      void releaseWakeLock()
      setDimmed(false)
    }
  }, [enabled])

  return { dimmed }
}
