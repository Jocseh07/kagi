import {
  CHALLENGE_HEADER,
  ChallengeRequiredError,
  CorsBlockedError,
  HttpStatusError,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from './types'

/**
 * Token-bucket limiter matching Mihon's `rateLimit(permits, period)`.
 * `exclude` mirrors the predicate form: matching requests bypass the limiter.
 */
export class RateLimiter {
  private readonly permits: number
  private readonly periodMs: number
  private readonly exclude: (url: URL) => boolean
  private timestamps: number[] = []

  constructor(
    permits: number,
    periodMs: number,
    exclude: (url: URL) => boolean = () => false,
  ) {
    this.permits = permits
    this.periodMs = periodMs
    this.exclude = exclude
  }

  async acquire(url: string): Promise<void> {
    if (this.exclude(new URL(url))) return

    for (;;) {
      const now = Date.now()
      this.timestamps = this.timestamps.filter((t) => now - t < this.periodMs)
      if (this.timestamps.length < this.permits) {
        this.timestamps.push(now)
        return
      }
      await sleep(this.periodMs - (now - this.timestamps[0]) + 1)
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Plain `fetch`. Works only against origins that send CORS headers.
 *
 * A cross-origin failure surfaces as an opaque `TypeError` with no detail —
 * the browser deliberately withholds the reason. We probe with `no-cors` to
 * tell "network is down" apart from "CORS refused" so the UI can say which.
 */
export class DirectFetchTransport implements HttpTransport {
  private readonly limiter?: RateLimiter

  constructor(limiter?: RateLimiter) {
    this.limiter = limiter
  }

  async fetch(req: HttpRequest): Promise<HttpResponse> {
    // The limiter can sleep for seconds; a request cancelled while it waits
    // must never reach the network at all.
    await this.limiter?.acquire(req.url)
    req.signal?.throwIfAborted()

    let res: Response
    try {
      res = await globalThis.fetch(req.url, {
        method: req.method ?? 'GET',
        headers: req.headers,
        body: req.body,
        credentials: 'omit',
        redirect: 'follow',
        signal: req.signal,
      })
    } catch (err) {
      // A cancelled request is not a failed one, and the probe below cannot
      // tell them apart: a healthy host answers `no-cors` whether or not the
      // caller walked away, so an abort would be reported as a CORS refusal.
      // Both forms are checked — `fetch` rejects with the signal's reason,
      // which is a DOMException named AbortError only when `abort()` was
      // called without one.
      if (req.signal?.aborted || isAbortError(err)) throw err

      const opaque = await reachableButOpaque(req.url)
      // The probe is a round trip of its own; a cancellation that landed while
      // it ran outranks whatever it concluded.
      req.signal?.throwIfAborted()
      if (opaque) throw new CorsBlockedError(req.url, err)
      throw err
    }

    if (!res.ok) {
      // Set by the dev proxy when the upstream answered with a bot check. The
      // status is an ordinary 503, so the header is the only thing that tells
      // this apart from the site being down.
      const challengeUrl = res.headers.get(CHALLENGE_HEADER)
      if (challengeUrl) throw new ChallengeRequiredError(challengeUrl, req.url)
      throw new HttpStatusError(res.status, req.url)
    }

    return {
      status: res.status,
      url: res.url,
      headers: res.headers,
      text: () => res.text(),
      json: <T,>() => res.json() as Promise<T>,
      blob: () => res.blob(),
    }
  }
}

/**
 * True when the host answers a `no-cors` request. The response is opaque and
 * unreadable, but reaching it at all proves the failure was CORS policy rather
 * than DNS, TLS, or connectivity.
 */
async function reachableButOpaque(url: string): Promise<boolean> {
  try {
    await globalThis.fetch(url, { mode: 'no-cors', credentials: 'omit' })
    return true
  } catch {
    return false
  }
}

/** `DOMException` is not reliably `instanceof Error` everywhere; match by name. */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}
