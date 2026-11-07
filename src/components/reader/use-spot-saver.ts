import { useEffect, useState } from 'react'

/**
 * Longest a moving reading position goes unsaved while the reader keeps
 * scrolling. A settle saves sooner; this only bounds a scroll that never stops.
 */
export const SAVE_HEARTBEAT_MS = 5000

/** How long a save may wait for the browser to go idle before it runs anyway. */
export const SAVE_IDLE_TIMEOUT_MS = 1500

export interface SpotSaverClock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  /** Runs the callback when the main thread is idle, or by `timeout` at the latest. */
  idle(callback: () => void, timeout: number): unknown
  cancelIdle(handle: unknown): void
}

export interface SpotSaver {
  /** The position moved; save it within the heartbeat. */
  request(): void
  /** The position stopped moving; save it at the next idle moment. */
  settle(): void
  /** Saves a pending position now, as the page is hidden or closed. */
  flush(): void
  dispose(): void
  /** Replaces what a save does, keeping the saver and its schedule. */
  setSave(save: () => void): void
}

const browserClock: SpotSaverClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  idle: (callback, timeout) =>
    typeof globalThis.requestIdleCallback === 'function'
      ? { idle: globalThis.requestIdleCallback(callback, { timeout }) }
      : { timer: globalThis.setTimeout(callback, 0) },
  cancelIdle: (handle) => {
    const held = handle as { idle?: number; timer?: ReturnType<typeof setTimeout> }
    if (held.idle !== undefined) globalThis.cancelIdleCallback(held.idle)
    if (held.timer !== undefined) globalThis.clearTimeout(held.timer)
  },
}

/**
 * Decides when the reading position is written, so it is never far behind and
 * never written in the middle of a scroll frame.
 *
 * Every save goes through an idle callback. Requests while scrolling collapse
 * into one save per heartbeat; a position that has not moved is not saved.
 */
export function createSpotSaver(
  initialSave: () => void,
  clock: SpotSaverClock = browserClock,
  heartbeatMs = SAVE_HEARTBEAT_MS,
): SpotSaver {
  let save = initialSave
  let dirty = false
  let lastSave = clock.now()
  let delay: unknown = null
  let idle: unknown = null

  const cancel = () => {
    if (delay !== null) clock.clearTimeout(delay)
    if (idle !== null) clock.cancelIdle(idle)
    delay = null
    idle = null
  }

  const run = () => {
    cancel()
    if (!dirty) return
    dirty = false
    lastSave = clock.now()
    save()
  }

  const whenIdle = () => {
    delay = null
    if (idle === null) idle = clock.idle(run, SAVE_IDLE_TIMEOUT_MS)
  }

  return {
    request() {
      dirty = true
      if (delay !== null || idle !== null) return
      const wait = lastSave + heartbeatMs - clock.now()
      if (wait <= 0) whenIdle()
      else delay = clock.setTimeout(whenIdle, wait)
    },
    settle() {
      dirty = true
      if (delay !== null) {
        clock.clearTimeout(delay)
        delay = null
      }
      whenIdle()
    },
    flush: run,
    dispose: cancel,
    setSave(next) {
      save = next
    },
  }
}

/**
 * The reader's save scheduler, flushed when the page is hidden, closed or the
 * reader unmounts. The saver itself never changes, so its functions can be
 * handed to memoised viewers.
 */
export function useSpotSaver(save: () => void): SpotSaver {
  const [saver] = useState(() => createSpotSaver(save))
  useEffect(() => {
    saver.setSave(save)
  }, [saver, save])

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') saver.flush()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', saver.flush)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', saver.flush)
      saver.flush()
      saver.dispose()
    }
  }, [saver])

  return saver
}
