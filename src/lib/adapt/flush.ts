import { notifyManager } from '@tanstack/react-query'

/** A generation writes many times a second; the screen catches up at most this often. */
const FLUSH_MS = 250

const tasks = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | undefined

function flush(): void {
  timer = undefined
  const due = [...tasks]
  tasks.clear()
  // Query updates and store listeners share react-query's notify queue, so one tick is one React commit.
  notifyManager.batch(() => {
    for (const task of due) task()
  })
}

/** Runs `task` once on the next tick, however often it is scheduled before then. */
export function scheduleFlush(task: () => void): void {
  tasks.add(task)
  timer ??= setTimeout(flush, FLUSH_MS)
}

export function cancelFlush(task: () => void): void {
  tasks.delete(task)
}

export interface FlushSignal {
  subscribe(listener: () => void): () => void
  notify(): void
}

/** Listeners hear about changes on the next tick, together with every other live store. */
export function createFlushSignal(): FlushSignal {
  const listeners = new Set<() => void>()
  const publish = () => {
    for (const listener of listeners) notifyManager.schedule(listener)
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    notify: () => scheduleFlush(publish),
  }
}
