/**
 * Holds a screen wake lock while the queue is downloading.
 *
 * This is the fallback half of background downloading, and it matters most on
 * the browsers that have no Background Fetch: there, the transfer is driven by
 * the page, and a phone that locks its screen freezes that page and with it the
 * download. Keeping the screen awake keeps the page alive.
 *
 * The lock is released by the browser whenever the document is hidden, and it
 * cannot be taken again until the document is visible, so it is reacquired on
 * `visibilitychange` rather than assumed to persist. Unsupported browsers get a
 * silent no-op: nothing here is load-bearing, it only buys time.
 */

interface WakeLockSentinelLike {
  released: boolean
  release(): Promise<void>
  addEventListener(type: 'release', listener: () => void): void
}

interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>
}

function wakeLock(): WakeLockLike | null {
  if (typeof navigator === 'undefined') return null
  const candidate = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock
  return candidate ?? null
}

let sentinel: WakeLockSentinelLike | null = null
/** Guards against a second request racing the first while one is in flight. */
let pending: Promise<void> | null = null

export function supportsWakeLock(): boolean {
  return wakeLock() !== null
}

export async function acquireWakeLock(): Promise<void> {
  const api = wakeLock()
  if (!api) return
  if (sentinel && !sentinel.released) return
  if (pending) return await pending
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
    // A hidden document is refused one; the visibility handler retries.
    return
  }

  pending = (async () => {
    try {
      const granted = await api.request('screen')
      granted.addEventListener('release', () => {
        if (sentinel === granted) sentinel = null
      })
      sentinel = granted
    } catch {
      // Denied by the browser or the platform. Downloading still works; it is
      // just at the mercy of the screen turning off.
    } finally {
      pending = null
    }
  })()

  await pending
}

export async function releaseWakeLock(): Promise<void> {
  const held = sentinel
  sentinel = null
  if (!held || held.released) return
  try {
    await held.release()
  } catch {
    // Already gone, which is the state we wanted.
  }
}
