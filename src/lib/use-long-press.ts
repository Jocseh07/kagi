/**
 * Press-and-hold on touch, as the stand-in for a hover that phones do not have.
 *
 * Touch and pen only: a mouse has its own affordance and firing on a held
 * click would be a trap. The hold is abandoned as soon as the finger travels,
 * because that finger is scrolling a grid, not choosing a card.
 */
import { useCallback, useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

/** Long enough not to catch a tap, short enough not to feel broken. */
const HOLD_MS = 500

/** How far a finger may drift before the hold is read as a scroll. */
const MOVE_TOLERANCE_PX = 10

export interface LongPressHandlers {
  onPointerDown(event: ReactPointerEvent): void
  onPointerMove(event: ReactPointerEvent): void
  onPointerUp(event: ReactPointerEvent): void
  onPointerCancel(event: ReactPointerEvent): void
}

export function useLongPress(
  onLongPress: () => void,
  { disabled = false }: { disabled?: boolean } = {},
): LongPressHandlers {
  const timer = useRef<number | null>(null)
  const origin = useRef<{ x: number; y: number } | null>(null)
  // The callback changes identity on every render of a card; reading it from a
  // ref keeps the handlers below stable for the memoized grid rows.
  const callback = useRef(onLongPress)

  useEffect(() => {
    callback.current = onLongPress
  }, [onLongPress])

  const clear = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    origin.current = null
  }, [])

  // A card scrolled out of view mid-hold must not fire from the grave.
  useEffect(() => clear, [clear])

  const start = useCallback(
    (event: ReactPointerEvent) => {
      if (disabled || event.pointerType === 'mouse') return
      clear()
      origin.current = { x: event.clientX, y: event.clientY }
      timer.current = window.setTimeout(() => {
        timer.current = null
        origin.current = null
        callback.current()
      }, HOLD_MS)
    },
    [disabled, clear],
  )

  const move = useCallback(
    (event: ReactPointerEvent) => {
      const from = origin.current
      if (!from) return
      const travelled =
        Math.abs(event.clientX - from.x) + Math.abs(event.clientY - from.y)
      if (travelled > MOVE_TOLERANCE_PX) clear()
    },
    [clear],
  )

  return {
    onPointerDown: start,
    onPointerMove: move,
    onPointerUp: clear,
    onPointerCancel: clear,
  }
}
