/**
 * Window-side driver for Background Fetch.
 *
 * The `CACHE_PAGES` path in `register.ts` only runs while a page is alive to
 * drive it: the loop lives in the service worker, but the worker is kept awake
 * by the page's request, and the page is what interprets the result. Hide the
 * tab and it is throttled; background a mobile PWA and it is frozen; close the
 * app and it is gone. Background Fetch hands the transfer to the browser
 * instead — it continues with the screen off and after the app is closed, and
 * shows up in the system download UI where the user can see and cancel it.
 *
 * The split is deliberate. Registering and watching happen here, because a live
 * page can hold a reference to the run and report real per-page progress from
 * it. Turning the downloaded bytes into cached pages happens in `public/sw.js`,
 * because that is the half that has to work when no page exists at all.
 *
 * Availability is Chromium-only. Everything here feature-detects and the caller
 * falls back to `cachePages`.
 */

import { ServiceWorkerError } from './register'
import type { CachePageOutcome, CachePagesProgress } from './register'
import { PAGE_CACHE, supportsOfflineSave } from './types'

/** Fallback poll, for a settlement message that arrived while frozen. */
const RESULT_POLL_INTERVAL_MS = 3_000

/** How long to wait for the worker to store a result after a run settles. */
const RESULT_GRACE_MS = 30_000

interface BackgroundFetchRecord {
  readonly request: Request
  readonly responseReady: Promise<Response>
}

interface BackgroundFetchRegistration extends EventTarget {
  readonly id: string
  readonly downloaded: number
  readonly result: '' | 'success' | 'failure'
  abort(): Promise<boolean>
  matchAll(): Promise<BackgroundFetchRecord[]>
}

interface BackgroundFetchManager {
  fetch(
    id: string,
    requests: readonly Request[],
    options?: { title?: string; icons?: { src: string; sizes?: string; type?: string }[] },
  ): Promise<BackgroundFetchRegistration>
  get(id: string): Promise<BackgroundFetchRegistration | undefined>
  getIds(): Promise<string[]>
}

type RegistrationWithBackgroundFetch = ServiceWorkerRegistration & {
  backgroundFetch?: BackgroundFetchManager
}

interface StoredResult {
  outcome: 'success' | 'failure' | 'aborted'
  results: CachePageOutcome[]
}

export interface BackgroundFetchOptions {
  /** Stable per chapter, so a reload adopts the run instead of restarting it. */
  id: string
  urls: readonly string[]
  /** Shown in the system download UI. */
  title: string
  signal?: AbortSignal
  onProgress?(progress: CachePagesProgress): void
}

export function supportsBackgroundFetch(): boolean {
  if (!supportsOfflineSave()) return false
  if (typeof window === 'undefined') return false
  return 'BackgroundFetchManager' in window
}

/** The registration id a chapter's run is always filed under. */
export function backgroundFetchIdFor(chapterId: string): string {
  return `chapter:${chapterId}`
}

/**
 * Runs a chapter's pages through Background Fetch and returns the same
 * per-URL outcomes `cachePages` does, so the two are interchangeable.
 *
 * Three ways in, all of them ordinary: a result already stored by the worker
 * (the run finished while the app was closed), a registration still in flight
 * (the app was reloaded mid-download), or a fresh registration.
 */
export async function runBackgroundFetch(
  options: BackgroundFetchOptions,
): Promise<CachePageOutcome[]> {
  const manager = await backgroundFetchManager()

  const finished = await readStoredResult(options.id)
  if (finished) {
    await clearStoredResult(options.id)
    return finished.results
  }

  const existing = await manager.get(options.id)
  const run = existing ?? (await start(manager, options))

  watchProgress(run, options)
  const abort = bindAbort(run, options.signal)
  try {
    return await settle(options.id, run)
  } finally {
    abort()
  }
}

/**
 * Registers a chapter's run without waiting on it.
 *
 * Used by the queue to hand the next few chapters to the browser before the
 * page is frozen by a locked screen. A run or a stored result already filed
 * under the id is left alone, so priming is idempotent, and `runBackgroundFetch`
 * later adopts whichever of the two it finds.
 */
export async function primeBackgroundFetch(
  options: Pick<BackgroundFetchOptions, 'id' | 'urls' | 'title'>,
): Promise<void> {
  const manager = await backgroundFetchManager()
  if (await readStoredResult(options.id)) return
  if (await manager.get(options.id)) return
  await start(manager, options)
}

/**
 * Takes a body the browser downloaded for a primed novel chapter.
 *
 * The worker files every harvested response in the page cache regardless of
 * what it was, so a proxied chapter page lands there next to the images. Prose
 * is parsed in the page rather than the worker, because that is where the
 * source code and `DOMParser` are, and the entry is deleted once read: it was
 * only ever a hand-off, and it is not what the reader opens. The stored run
 * result is cleared too, so the id is free for a later re-download.
 */
export async function takeCachedBody(
  id: string,
  url: string,
): Promise<string | null> {
  if (!supportsOfflineSave()) return null
  try {
    const cache = await caches.open(PAGE_CACHE)
    const match = await cache.match(url)
    if (!match) return null
    const body = await match.text()
    await cache.delete(url)
    await clearStoredResult(id)
    return body
  } catch {
    return null
  }
}

/** Drops a run and its stored result, for a chapter leaving the queue. */
export async function cancelBackgroundFetch(id: string): Promise<void> {
  try {
    const manager = await backgroundFetchManager()
    const run = await manager.get(id)
    if (run) await run.abort()
    await clearStoredResult(id)
  } catch {
    // Cancelling is best effort: a run that cannot be found is already gone.
  }
}

async function start(
  manager: BackgroundFetchManager,
  options: BackgroundFetchOptions,
): Promise<BackgroundFetchRegistration> {
  // `no-referrer` and `omit` mirror what the reader's <img> sends, exactly as
  // the CACHE_PAGES path does, so the CDN sees the request shape it serves.
  const requests = options.urls.map(
    (url) =>
      new Request(url, {
        mode: 'no-cors',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      }),
  )

  // `downloadTotal` is deliberately left unset. The browser aborts a run that
  // exceeds it, and a page image's size is unknown until it arrives, so any
  // guess risks failing a download that was going fine. The cost is an
  // indeterminate bar in the system UI; the in-app one is exact either way.
  return await manager.fetch(options.id, requests, {
    title: options.title,
    icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
  })
}

/**
 * Reports pages as they land.
 *
 * Each record's `responseReady` settles when that page finishes, which is a
 * true per-page count — unlike the `progress` event, which only carries bytes
 * and cannot be turned into a page count without knowing the sizes up front.
 */
function watchProgress(
  run: BackgroundFetchRegistration,
  options: BackgroundFetchOptions,
): void {
  if (!options.onProgress) return
  const total = options.urls.length
  let completed = 0

  void run.matchAll().then(
    (records) => {
      for (const record of records) {
        const tick = (): void => {
          completed += 1
          options.onProgress?.({ completed, total })
        }
        record.responseReady.then(tick, tick)
      }
    },
    () => undefined,
  )
}

function bindAbort(
  run: BackgroundFetchRegistration,
  signal: AbortSignal | undefined,
): () => void {
  if (!signal) return () => undefined
  const onAbort = (): void => {
    void run.abort().catch(() => undefined)
  }
  if (signal.aborted) {
    onAbort()
    return () => undefined
  }
  signal.addEventListener('abort', onAbort, { once: true })
  return () => signal.removeEventListener('abort', onAbort)
}

/**
 * Waits for the worker to store the run's outcome.
 *
 * The worker's `backgroundfetchsuccess` handler is what actually writes the
 * pages into the cache, so its stored result is the only authority on what was
 * kept — the registration settling merely means the bytes arrived. Both a push
 * message and a poll are used: the message is instant while the page is awake,
 * and the poll covers a page that was frozen when it was sent.
 */
async function settle(
  id: string,
  run: BackgroundFetchRegistration,
): Promise<CachePageOutcome[]> {
  const stored = await new Promise<StoredResult | null>((resolve) => {
    let done = false
    let settledAt: number | null = null

    const finish = (value: StoredResult | null): void => {
      if (done) return
      done = true
      globalThis.clearInterval(poll)
      navigator.serviceWorker.removeEventListener('message', onMessage)
      resolve(value)
    }

    const check = (): void => {
      void readStoredResult(id).then((result) => {
        if (result) {
          finish(result)
          return
        }
        // A settled registration with no stored result means the worker was
        // killed before it could finish harvesting, or never woke at all. Give
        // it a grace period, then give up so the item can be retried.
        if (run.result === '') return
        settledAt ??= Date.now()
        if (Date.now() - settledAt > RESULT_GRACE_MS) finish(null)
      }, () => undefined)
    }

    const onMessage = (event: MessageEvent<unknown>): void => {
      const data: unknown = event.data
      if (typeof data !== 'object' || data === null) return
      const message = data as { type?: unknown; id?: unknown }
      if (message.type !== 'BACKGROUND_FETCH_SETTLED') return
      if (message.id !== id) return
      check()
    }

    navigator.serviceWorker.addEventListener('message', onMessage)
    const poll = globalThis.setInterval(check, RESULT_POLL_INTERVAL_MS)
    check()
  })

  if (!stored) {
    throw new ServiceWorkerError(
      'timeout',
      'The background download finished but the service worker did not report what it kept.',
    )
  }

  await clearStoredResult(id)
  return stored.results
}

// --------------------------------------------------------- worker plumbing --

async function backgroundFetchManager(): Promise<BackgroundFetchManager> {
  if (!supportsBackgroundFetch()) {
    throw new ServiceWorkerError(
      'unsupported',
      'This browser has no Background Fetch support.',
    )
  }
  const registration =
    (await navigator.serviceWorker.getRegistration()) as
      | RegistrationWithBackgroundFetch
      | undefined
  const manager = registration?.backgroundFetch
  if (!manager) {
    throw new ServiceWorkerError(
      'no-controller',
      'No active service worker is available to run a background download.',
    )
  }
  return manager
}

async function readStoredResult(id: string): Promise<StoredResult | null> {
  const reply = await ask({ type: 'BACKGROUND_FETCH_RESULT', id })
  const result = (reply as { result?: unknown }).result
  if (typeof result !== 'object' || result === null) return null
  const { outcome, results } = result as StoredResult
  if (outcome !== 'success' && outcome !== 'failure' && outcome !== 'aborted') {
    return null
  }
  return { outcome, results: Array.isArray(results) ? results : [] }
}

async function clearStoredResult(id: string): Promise<void> {
  try {
    await ask({ type: 'BACKGROUND_FETCH_CLEAR', id })
  } catch {
    // A stale result is overwritten by the next run under the same id.
  }
}

/**
 * A one-shot message to the worker.
 *
 * Deliberately not `register.ts`'s `request`: these exchanges are reads of a
 * small cached record and answer immediately, and unlike a page fetch they must
 * not be held open by a watchdog while the run they describe is still going.
 */
async function ask(
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const registration = await navigator.serviceWorker.getRegistration()
  const worker = navigator.serviceWorker.controller ?? registration?.active
  if (!worker) {
    throw new ServiceWorkerError(
      'no-controller',
      'No active service worker is controlling this page.',
    )
  }

  return await new Promise((resolve, reject) => {
    const channel = new MessageChannel()
    const timer = globalThis.setTimeout(() => {
      channel.port1.close()
      reject(
        new ServiceWorkerError(
          'timeout',
          `The service worker did not answer ${String(message.type)}.`,
        ),
      )
    }, 10_000)

    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      globalThis.clearTimeout(timer)
      channel.port1.close()
      const data: unknown = event.data
      resolve(typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {})
    }

    worker.postMessage(message, [channel.port2])
  })
}
