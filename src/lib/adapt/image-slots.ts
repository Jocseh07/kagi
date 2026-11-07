interface Waiter {
  limit: number
  priority: number
  grant(): void
}

export type WithSlot = <T>(limit: number, priority: number, signal: AbortSignal, run: () => Promise<T>) => Promise<T>

/**
 * A semaphore that serves the lowest priority first (arrival order within a priority).
 * The limit is read per call, so a new setting applies to the next acquire.
 */
export function createSlots(): WithSlot {
  let active = 0
  const queue: Waiter[] = []

  function drain(): void {
    while (queue.length && active < queue[0].limit) queue.shift()!.grant()
  }

  function acquire(limit: number, priority: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason)
    if (!queue.length && active < limit) {
      active++
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        limit,
        priority,
        grant() {
          signal.removeEventListener('abort', onAbort)
          active++
          resolve()
        },
      }
      function onAbort() {
        const index = queue.indexOf(waiter)
        if (index >= 0) queue.splice(index, 1)
        reject(signal.reason)
        drain()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      let index = queue.length
      while (index > 0 && queue[index - 1].priority > priority) index--
      queue.splice(index, 0, waiter)
    })
  }

  return async (limit, priority, signal, run) => {
    await acquire(limit, priority, signal)
    try {
      signal.throwIfAborted()
      return await run()
    } finally {
      active--
      drain()
    }
  }
}

export const imageSlots = createSlots()
