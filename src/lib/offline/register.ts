/**
 * Window-side client for `public/sw.js`.
 *
 * The worker owns the page cache; nothing here reads a page's bytes directly.
 * These helpers only ask it to store, drop, or report on URLs, and take its
 * word for what each stored page weighs.
 */

import { supportsOfflineSave } from './types'

const SW_URL = '/sw.js'

/** Saving a chapter means dozens of CDN round trips, so it gets a long leash. */
/** Per-page allowance for a paced CACHE_PAGES run, on top of the pacing itself. */
const CACHE_PAGE_TIMEOUT_MS = 20_000
const CACHE_PAGES_MIN_TIMEOUT_MS = 60_000

/** How often the watchdog below checks whether an exchange has gone quiet. */
const WATCHDOG_INTERVAL_MS = 1_000
/** Matches DEFAULT_PAGE_FETCH_INTERVAL_MS in public/sw.js. */
const DEFAULT_PAGE_FETCH_INTERVAL_MS = 1100
const DEFAULT_TIMEOUT_MS = 10_000

/** How long to wait for the new worker to take over before reloading anyway. */
const CONTROLLER_CHANGE_TIMEOUT_MS = 5_000

/**
 * Marks that this page load already activated a waiting worker on its own.
 *
 * A worker found waiting at startup is applied without asking: nothing is
 * mid-read yet, and a plain refresh would otherwise show the same prompt on
 * every load until its own Reload button was pressed. The flag is what stops a
 * worker that never takes over from reloading the page forever; it is cleared
 * once a load starts with nothing waiting.
 */
const AUTO_APPLIED_KEY = 'sw:auto-applied'

export type ServiceWorkerErrorCode =
  | 'unsupported'
  | 'no-controller'
  | 'timeout'
  | 'bad-reply'
  | 'aborted'

export class ServiceWorkerError extends Error {
  readonly code: ServiceWorkerErrorCode

  constructor(code: ServiceWorkerErrorCode, message: string) {
    super(message)
    this.name = 'ServiceWorkerError'
    this.code = code
  }
}

export interface CachePageOutcome {
  url: string
  ok: boolean
  /** Failure detail from the worker, e.g. `QuotaExceededError`. */
  error?: string
  /**
   * What the stored page really weighs, or null when it cannot be known.
   *
   * Null for every failure, and for a page that arrived opaque: a cross-origin
   * CDN response cannot be read and is padded to a fixed size for quota
   * accounting anyway. Sources proxied through this origin are readable, so a
   * chapter of one sums to its exact cost.
   */
  bytes: number | null
}

export interface DeletePageOutcome {
  url: string
  /** True when an entry existed and was removed. */
  ok: boolean
}

/** Pages handled so far by a `cachePages` run still in flight. */
export interface CachePagesProgress {
  completed: number
  total: number
}

export type RegisterOutcome =
  | { ok: true; registration: ServiceWorkerRegistration }
  | {
      ok: false
      reason: 'unsupported' | 'failed'
      message: string
    }

export interface RegisterOptions {
  /**
   * Called once a newer worker is installed and waiting. `apply` activates it
   * and reloads the page, so the UI can put it behind a "Reload to update"
   * prompt instead of yanking the page out from under the reader.
   */
  onUpdateReady?(apply: () => Promise<void>): void
}

type OutboundMessage =
  | { type: 'CACHE_PAGES'; urls: string[]; minIntervalMs?: number; token: string }
  | { type: 'CACHE_PAGES_CANCEL'; token: string }
  | { type: 'DELETE_PAGES'; urls: string[] }
  | { type: 'CACHED_URLS'; urls: string[] }
  | { type: 'SKIP_WAITING' }

let registration: Promise<RegisterOutcome> | undefined

/**
 * Registers the worker. Safe to call repeatedly; only the first call's options
 * take effect.
 *
 * Dev included, so saving can be exercised without a production build. The
 * fetch handler claims only navigations, `/assets/*` and image requests, and
 * Vite serves dev modules from `/src/*`, `/@vite/*` and `/node_modules/*`
 * — none of which it touches — so HMR is unaffected. Note the registration
 * outlives the dev server and controls whatever else is served on that port;
 * unregister it from DevTools if a worker edit goes bad.
 */
export function registerServiceWorker(
  options: RegisterOptions = {},
): Promise<RegisterOutcome> {
  registration ??= performRegistration(options)
  return registration
}

async function performRegistration(
  options: RegisterOptions,
): Promise<RegisterOutcome> {
  if (!supportsOfflineSave()) {
    return {
      ok: false,
      reason: 'unsupported',
      message: 'This browser has no service worker or Cache API support.',
    }
  }

  try {
    const created = await navigator.serviceWorker.register(SW_URL, {
      scope: '/',
      // Never let the HTTP cache hand back a stale worker script.
      updateViaCache: 'none',
    })
    watchForUpdates(created, options.onUpdateReady)
    return { ok: true, registration: created }
  } catch (error) {
    return { ok: false, reason: 'failed', message: describeError(error) }
  }
}

function watchForUpdates(
  target: ServiceWorkerRegistration,
  onUpdateReady: RegisterOptions['onUpdateReady'],
): void {
  if (!onUpdateReady) return

  const announce = (worker: ServiceWorker): void => {
    // A worker installed with no controller is the very first install: there is
    // nothing to replace, so there is nothing to prompt about.
    if (worker.state !== 'installed') return
    if (!navigator.serviceWorker.controller) return
    onUpdateReady(() => applyUpdate(worker))
  }

  if (target.waiting) {
    if (autoApplyOnce()) {
      void applyUpdate(target.waiting)
      return
    }
    announce(target.waiting)
  } else {
    clearAutoApplied()
  }

  target.addEventListener('updatefound', () => {
    const installing = target.installing
    if (!installing) return
    installing.addEventListener('statechange', () => announce(installing))
  })
}

/** True the first time per page load; false once a reload has been spent. */
function autoApplyOnce(): boolean {
  try {
    if (sessionStorage.getItem(AUTO_APPLIED_KEY)) return false
    sessionStorage.setItem(AUTO_APPLIED_KEY, '1')
    return true
  } catch {
    return false
  }
}

function clearAutoApplied(): void {
  try {
    sessionStorage.removeItem(AUTO_APPLIED_KEY)
  } catch {
    // Storage blocked: the flag was never set either, so nothing to clear.
  }
}

async function applyUpdate(worker: ServiceWorker): Promise<void> {
  const tookOver = new Promise<void>((resolve) => {
    const timer = globalThis.setTimeout(resolve, CONTROLLER_CHANGE_TIMEOUT_MS)
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => {
        globalThis.clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })

  worker.postMessage({ type: 'SKIP_WAITING' } satisfies OutboundMessage)
  await tookOver
  globalThis.location.reload()
}

/** True when a worker is active and able to answer messages. */
export async function isServiceWorkerReady(): Promise<boolean> {
  if (!supportsOfflineSave()) return false
  if (navigator.serviceWorker.controller) return true
  try {
    // Deliberately not `serviceWorker.ready`: it never settles when nothing is
    // registered, which would hang every caller in an unsupported browser.
    const current = await navigator.serviceWorker.getRegistration()
    return current?.active?.state === 'activated'
  } catch {
    return false
  }
}

/**
 * Asks the worker to fetch and store each URL.
 *
 * A per-URL `ok: true` only means the response was stored. A cross-origin page
 * is stored opaque and cannot be inspected, so it may still be a 404 page;
 * callers that need certainty must verify by loading the cached URL into an
 * `Image`. Each outcome also carries the page's real size where the worker
 * could read one — see `CachePageOutcome.bytes`.
 */
/**
 * @param minIntervalMs Minimum gap between page fetches. These requests are
 * issued by the service worker and so bypass the source's own RateLimiter;
 * pass the source's real interval to avoid tripping its per-IP limit.
 * @param onProgress Called as each page is handled, so a run that takes a
 * minute can be shown moving. A worker too old to send these simply never
 * calls it; the final result is unaffected.
 * @param signal Stops the worker's run. Pages already stored stay in the
 * cache; the promise rejects with an `aborted` error.
 */
export async function cachePages(
  urls: readonly string[],
  minIntervalMs?: number,
  onProgress?: (progress: CachePagesProgress) => void,
  signal?: AbortSignal,
): Promise<CachePageOutcome[]> {
  if (urls.length === 0) return []
  if (signal?.aborted) {
    throw new ServiceWorkerError('aborted', 'Saving was cancelled.')
  }
  const token = runToken()
  // The worker paces its fetches, so the deadline has to cover the pacing plus
  // a per-page network allowance; a fixed timeout would abort long chapters.
  const interval = minIntervalMs ?? DEFAULT_PAGE_FETCH_INTERVAL_MS
  // A silence budget, not a budget for the whole run: the worker reports after
  // every page, so what a stuck run looks like is one page's allowance passing
  // with nothing said. Sizing it for the whole chapter instead made the timer
  // meaningless on long chapters and, worse, made it fire on a *finished* run
  // whose page had been throttled or frozen in between.
  const timeout = Math.max(
    CACHE_PAGES_MIN_TIMEOUT_MS,
    interval + CACHE_PAGE_TIMEOUT_MS,
  )
  const reply = await request(
    { type: 'CACHE_PAGES', urls: [...urls], minIntervalMs, token },
    timeout,
    'CACHE_PAGES_RESULT',
    onProgress
      ? {
          type: 'CACHE_PAGES_PROGRESS',
          handle: (message) => {
            const completed = message.completed
            const total = message.total
            if (typeof completed !== 'number' || typeof total !== 'number') return
            onProgress({ completed, total })
          },
        }
      : undefined,
    signal,
  )
  return parseOutcomes(reply.results)
}

function runToken(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random()}`
}

export async function deletePages(
  urls: readonly string[],
): Promise<DeletePageOutcome[]> {
  if (urls.length === 0) return []
  const reply = await request(
    { type: 'DELETE_PAGES', urls: [...urls] },
    DEFAULT_TIMEOUT_MS,
    'DELETE_PAGES_RESULT',
  )
  return parseOutcomes(reply.results)
}

/** Subset of `urls` currently held in the page cache. */
export async function cachedUrls(
  urls: readonly string[],
): Promise<string[]> {
  if (urls.length === 0) return []
  const reply = await request(
    { type: 'CACHED_URLS', urls: [...urls] },
    DEFAULT_TIMEOUT_MS,
    'CACHED_URLS_RESULT',
  )
  if (!Array.isArray(reply.present)) {
    throw new ServiceWorkerError(
      'bad-reply',
      'CACHED_URLS_RESULT did not include a list of URLs.',
    )
  }
  return reply.present.filter((url): url is string => typeof url === 'string')
}

/**
 * One request/reply exchange over a private `MessageChannel`.
 *
 * `interim` lets a long-running request report on itself: messages of that
 * type are handed to the caller and the port stays open, so only the expected
 * terminal message settles the exchange.
 */
interface InterimHandler {
  type: string
  handle(message: Record<string, unknown>): void
}

async function request(
  message: OutboundMessage,
  timeoutMs: number,
  expected: string,
  interim?: InterimHandler,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const worker = await activeWorker()

  const reply = await new Promise<unknown>((resolve, reject) => {
    const channel = new MessageChannel()
    let lastHeard = Date.now()
    let wasHidden = false

    // Only a CACHE_PAGES run can be stopped; the worker is told by token and
    // the exchange is settled here at once rather than waiting on its reply.
    const onAbort = (): void => {
      globalThis.clearInterval(watchdog)
      channel.port1.close()
      if (message.type === 'CACHE_PAGES') {
        worker.postMessage({
          type: 'CACHE_PAGES_CANCEL',
          token: message.token,
        } satisfies OutboundMessage)
      }
      reject(new ServiceWorkerError('aborted', 'Saving was cancelled.'))
    }

    // A watchdog rather than one long `setTimeout`. Two reasons, both about
    // backgrounded pages: a hidden tab's timers are throttled to once a minute,
    // so a single deadline fires late and then immediately on unfreeze, failing
    // a run the worker actually completed; and the worker keeps working while
    // the page is hidden, so silence there is expected rather than a fault.
    const watchdog = globalThis.setInterval(() => {
      if (documentHidden()) {
        // The clock only runs while someone is watching. A hidden page cannot
        // tell a stalled worker from a throttled message pump.
        lastHeard = Date.now()
        wasHidden = true
        return
      }
      if (wasHidden) {
        // The first tick back is measured from before the freeze, which would
        // count the whole background gap as silence.
        wasHidden = false
        lastHeard = Date.now()
        return
      }
      if (Date.now() - lastHeard < timeoutMs) return
      globalThis.clearInterval(watchdog)
      channel.port1.close()
      signal?.removeEventListener('abort', onAbort)
      reject(
        new ServiceWorkerError(
          'timeout',
          `The service worker went quiet for ${timeoutMs}ms during ${message.type}.`,
        ),
      )
    }, WATCHDOG_INTERVAL_MS)
    signal?.addEventListener('abort', onAbort, { once: true })

    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const data: unknown = event.data
      lastHeard = Date.now()
      if (interim && isRecord(data) && data.type === interim.type) {
        interim.handle(data)
        return
      }
      globalThis.clearInterval(watchdog)
      channel.port1.close()
      signal?.removeEventListener('abort', onAbort)
      resolve(data)
    }

    worker.postMessage(message, [channel.port2])
  })

  if (!isRecord(reply) || reply.type !== expected) {
    throw new ServiceWorkerError(
      'bad-reply',
      `Expected ${expected} from the service worker.`,
    )
  }
  return reply
}

async function activeWorker(): Promise<ServiceWorker> {
  if (!supportsOfflineSave()) {
    throw new ServiceWorkerError(
      'unsupported',
      'This browser has no service worker or Cache API support.',
    )
  }

  const controller = navigator.serviceWorker.controller
  if (controller) return controller

  // On the very first load the worker activates and claims the page a moment
  // after it registers, so fall back to the registration's active worker.
  const current = await navigator.serviceWorker.getRegistration()
  const worker = current?.active
  if (!worker) {
    throw new ServiceWorkerError(
      'no-controller',
      'No active service worker is controlling this page.',
    )
  }
  return worker
}

function parseOutcomes(value: unknown): CachePageOutcome[] {
  if (!Array.isArray(value)) {
    throw new ServiceWorkerError(
      'bad-reply',
      'The service worker reply did not include per-URL results.',
    )
  }
  return value.filter(isRecord).map((entry) => ({
    url: typeof entry.url === 'string' ? entry.url : '',
    ok: entry.ok === true,
    error: typeof entry.error === 'string' ? entry.error : undefined,
    // A worker too old to report sizes says nothing, which reads the same as a
    // page it could not measure: no figure, so the caller projects instead.
    bytes:
      typeof entry.bytes === 'number' && Number.isFinite(entry.bytes)
        ? entry.bytes
        : null,
  }))
}

function documentHidden(): boolean {
  return (
    typeof document !== 'undefined' && document.visibilityState === 'hidden'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
