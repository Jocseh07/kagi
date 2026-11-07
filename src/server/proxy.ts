/**
 * One same-origin hop per closed source, served by the Start server route that
 * calls it.
 *
 * This used to be split in two: a Node proxy in the Vite dev server for the
 * plain CORS withholders, and a curl hop for the TLS-fingerprinted one, with
 * a third copy in a Nitro Worker for production. Dev and production are now
 * the same workerd runtime, so there is one implementation and it is the
 * deployed one.
 *
 * The challenge detector below is what tells us whether the Worker's TLS
 * fingerprint passed. A challenged response is answered with 503 +
 * `x-proxy-challenge`, the contract `CHALLENGE_HEADER` in
 * src/lib/transport/types.ts documents.
 */

/** Kept in step with `CHALLENGE_HEADER` in src/lib/transport/types.ts. */
const CHALLENGE_HEADER = 'x-proxy-challenge'

import { SOURCE_BROWSER_HEADERS as BROWSER_HEADERS } from '../lib/transport/source-policy'
import * as Effect from 'effect/Effect'

import { Env } from './effect/env'
import type { KagiEnv } from './effect/env'
import { attempt } from './effect/errors'
import { rateLimitProxy } from './rate-limit'


/**
 * Response headers that survive the hop.
 *
 * An allowlist rather than a blocklist: the upstream's `set-cookie`,
 * `access-control-*` and `strict-transport-security` all describe *its* origin
 * and would be wrong, or actively harmful, asserted about this one.
 */
const FORWARDED_HEADERS = [
  'content-type',
  'cache-control',
  'etag',
  'last-modified',
] as const

/**
 * Freshness given to an image whose CDN sent none.
 *
 * `public` rather than `private`: the proxies need no sign-in and a page image
 * carries nothing about the reader who asked for it. It is also what lets the
 * colo hold one: the Cache API refuses to store a `private` response.
 */
const IMAGE_CACHE_CONTROL = 'public, max-age=604800, immutable'

/**
 * Where a proxied image is held in the colo.
 *
 * Keyed under this deployment's own origin because the Cache API only accepts
 * a key on a hostname the zone owns. `/__proxy-cache/*` matches no route and
 * is never requested over the network.
 */
function cacheKeyUrl(target: URL, env: KagiEnv): string {
  const base = env.APP_ORIGIN?.trim() || 'https://kagi.invalid'
  return `${new URL(base).origin}/__proxy-cache/${encodeURIComponent(target.toString())}`
}

export interface ProxyToOptions {
  /** Path prefix the app requests, e.g. `/mangadot`. */
  prefix: string
  /**
   * Origin the request is forwarded to, e.g. `https://mangadot.net`.
   *
   * With `hostPattern` set this is ignored in favour of the host named in
   * the path; it is still required so every route reads the same.
   */
  target: string
  /**
   * Accept the upstream host from the path instead of `target`: the first
   * segment after the prefix is the hostname, and it must match this
   * pattern. `/mdimage/abc.mangadex.network/data/...` forwards to
   * `https://abc.mangadex.network/data/...`. Exists for sources whose image
   * host is chosen per chapter, which a fixed `target` cannot express.
   *
   * Anchor the pattern. A loose one turns the route into an open proxy.
   */
  hostPattern?: RegExp
  /**
   * Follow redirects upstream (`follow`) or hand them back to the browser
   * (`manual`). With `manual`, an absolute `Location` on the target's own
   * origin is rewritten back under the prefix — without that the browser
   * follows it off the proxy and fails the CORS check the proxy exists to
   * avoid.
   */
  redirects: 'follow' | 'manual'
  /** Send the full browser-ish header set rather than just a User-Agent. */
  browserHeaders?: boolean
  /**
   * A User-Agent of our own, for sites that require one that is not spoofed.
   * Overrides the browser-ish one above.
   */
  userAgent?: string
  /**
   * Sent as the `Referer`. The browser never sends one through the reader or
   * the service worker (`no-referrer`), so an image host that hotlink-checks
   * gets it from here or not at all.
   */
  referer?: string
  /** Consent and age-gate cookies the site expects. Never user data. */
  cookies?: Record<string, string>
  /** Static request headers, e.g. a session token an API insists on. */
  headers?: Record<string, string>
  /**
   * Request query parameters lifted into request headers, and removed from
   * the forwarded URL. The name is the query key, the value the header it
   * becomes. For per-request tokens a source cannot set on an `<img>`.
   */
  headerParams?: Record<string, string>
  /**
   * Name of a query parameter carrying a hex key. When present, the response
   * body is XORed with it byte by byte before it reaches the browser, and the
   * parameter is stripped from the upstream request. MANGA Plus only.
   */
  xorKeyParam?: string
  /**
   * This prefix serves immutable binary assets: covers and page images.
   *
   * Declared by the route rather than sniffed from `content-type`, because
   * MangaDex's cover host sends no content-type at all and it is exactly the
   * image the library grid asks for most. It turns on the default freshness
   * above and the colo cache; a prefix serving listings or chapter lists must
   * leave it off, since those are the things that change.
   */
  assets?: boolean
}

/**
 * The hop. Charges the caller's proxy budget, then forwards.
 *
 * The forwarding itself is a plain async function: it is one long sequence of
 * fetch-and-header work with no service of its own beyond the bindings handed
 * to it, and expressing it as a generator would buy nothing.
 */
export const proxyTo = Effect.fn('proxy.to')(function* (
  request: Request,
  options: ProxyToOptions,
) {
  // Refused before any parsing: the proxies need no sign-in, so this is the
  // only thing between a scraper and the upstream sites.
  const limited = yield* rateLimitProxy(request)
  if (limited) return limited

  const env = yield* Env
  return yield* attempt(
    () => forward(request, options, env),
    'The upstream source could not be reached.',
  )
})

async function forward(
  request: Request,
  options: ProxyToOptions,
  env: KagiEnv,
): Promise<Response> {
  // The path carries the prefix and the query string; the suffix is what the
  // upstream site should see.
  const incoming = new URL(request.url)
  let path = incoming.pathname.slice(options.prefix.length)

  let origin = new URL(options.target).origin
  if (options.hostPattern) {
    const [, host, ...rest] = path.split('/')
    if (!host || !options.hostPattern.test(host)) {
      return new Response('Proxy host is not allowed', { status: 400 })
    }
    origin = `https://${host}`
    path = `/${rest.join('/')}`
  }

  const search = new URLSearchParams(incoming.search)
  const lifted: Record<string, string> = {}
  for (const [param, header] of Object.entries(options.headerParams ?? {})) {
    const value = search.get(param)
    if (value !== null) {
      lifted[header] = value
      search.delete(param)
    }
  }
  let xorKey: Uint8Array | null = null
  if (options.xorKeyParam) {
    const hex = search.get(options.xorKeyParam)
    if (hex) {
      xorKey = decodeHex(hex)
      search.delete(options.xorKeyParam)
    }
  }
  const query = search.toString()
  const suffix = (path + (query ? `?${query}` : '')) || '/'

  // The URL is rebuilt against a fixed origin, but a suffix like
  // `//evil.example/x` would still re-point it, so the origin is checked
  // rather than assumed.
  let url: URL
  try {
    url = new URL(suffix, origin)
  } catch {
    return new Response('Bad proxy path', { status: 400 })
  }
  if (url.origin !== origin) {
    return new Response('Proxy path escaped the configured target', {
      status: 400,
    })
  }

  // Every source call in the app is a GET; anything else has no business on
  // the proxy and is refused rather than forwarded.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 })
  }

  // A HEAD carries no body to hold, and an XOR'd response is keyed by a
  // per-request key that is stripped from the upstream URL, so two readers
  // with different keys would collide on one entry.
  const cacheable = request.method === 'GET' && options.assets === true && !options.xorKeyParam

  const headers: Record<string, string> = options.browserHeaders
    ? { ...BROWSER_HEADERS }
    : { 'User-Agent': BROWSER_HEADERS['User-Agent']! }
  if (options.userAgent) headers['User-Agent'] = options.userAgent
  if (options.referer) headers.Referer = options.referer
  if (options.cookies) {
    headers.Cookie = Object.entries(options.cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ')
  }
  Object.assign(headers, options.headers, lifted)

  // A page image the colo has already pulled for another reader. Looked up
  // after the rate limit on purpose: a hit still spends the caller's budget,
  // so the cache cannot be used to sidestep it.
  const cacheKey = cacheable ? new Request(cacheKeyUrl(url, env)) : null
  if (cacheKey) {
    const hit = await caches.default.match(cacheKey).catch(() => undefined)
    if (hit) return hit
  }

  const upstream = await fetch(url, {
    method: request.method,
    redirect: options.redirects,
    headers,
  })

  // 304 sits in the 3xx range but is not a redirect, and treating it as one
  // would answer a revalidation with a `location`-only response. Nothing sends
  // conditional headers through here today — they are not forwarded — so this
  // is a guard rather than a fix, and it is cheaper than the bug.
  if (upstream.status >= 300 && upstream.status < 400 && upstream.status !== 304) {
    const responseHeaders = new Headers()
    const location = upstream.headers.get('location')
    if (location) {
      responseHeaders.set(
        'location',
        location.startsWith(origin)
          ? options.prefix + location.slice(origin.length)
          : location,
      )
    }
    return new Response(null, { status: upstream.status, headers: responseHeaders })
  }

  const challenged = await asChallenge(upstream, url)
  if (challenged) return challenged

  // Content-length and content-encoding are deliberately dropped: the runtime
  // recomputes them for the stream it actually sends.
  //
  // The freshness headers are forwarded, and that is not cosmetic. Page images
  // are immutable and their CDNs say so — Asura's sends
  // `max-age=31536000, immutable`. Dropping that made every proxied image
  // uncacheable by the browser, so scrolling back through a chapter, or
  // reopening one, refetched every page through the Worker. Passing them
  // through restores what reading the CDN directly already gave, which is the
  // baseline the proxy has to match rather than undercut.
  const responseHeaders = new Headers()
  for (const name of FORWARDED_HEADERS) {
    const value = upstream.headers.get(name)
    if (value) responseHeaders.set(name, value)
  }

  // A safety net, not the common case. Measured from a colo, MangaDex sends
  // `public, max-age=604800, immutable` on page images and
  // `max-age=315360000` on covers, and those are forwarded above untouched.
  // This only covers an asset host that sends no freshness at all, where the
  // browser would otherwise come back through the Worker for a picture it
  // already has. The value matches what the hosts that do send one agree on.
  if (options.assets && !responseHeaders.has('cache-control')) {
    responseHeaders.set('cache-control', IMAGE_CACHE_CONTROL)
  }

  let body = request.method === 'HEAD' ? null : upstream.body
  if (body && xorKey) body = body.pipeThrough(xorStream(xorKey))

  const response = new Response(body, {
    status: upstream.status,
    headers: responseHeaders,
  })

  if (
    cacheKey &&
    upstream.status === 200 &&
    !/no-store|private/i.test(responseHeaders.get('cache-control') ?? '')
  ) {
    // `clone()` tees natively, and the write runs past the response, so the
    // reader who paid for the miss still streams rather than waiting for the
    // colo to finish storing it.
    env.waitUntil(caches.default.put(cacheKey, response.clone()).catch(() => undefined))
  }

  return response
}

/**
 * Whether the response is Cloudflare asking for a human rather than the site
 * refusing us outright. Status alone is not enough — a site is free to answer
 * 403 for its own reasons — so a marker has to appear too. Error pages are
 * small, so buffering one to inspect it costs nothing; the happy path never
 * reads the body here.
 */
async function asChallenge(
  upstream: Response,
  url: URL,
): Promise<Response | null> {
  const status = upstream.status
  if (status !== 403 && status !== 503 && status !== 429) return null

  let marked = upstream.headers.get('cf-mitigated') === 'challenge'
  if (!marked) {
    const body = await upstream.text()
    marked = /Just a moment|cf-chl-|challenge-platform/i.test(body.slice(0, 4096))
    if (!marked) {
      // An ordinary upstream error; the body was consumed to inspect it, so
      // hand back what was read.
      return new Response(body, { status })
    }
  } else {
    // The stream must be drained either way on Workers.
    await upstream.body?.cancel()
  }

  return new Response('Upstream returned a Cloudflare challenge', {
    status: 503,
    headers: {
      [CHALLENGE_HEADER]: url.toString(),
      'content-type': 'text/plain; charset=utf-8',
    },
  })
}

function decodeHex(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-f]/gi, '')
  const bytes = new Uint8Array(Math.floor(clean.length / 2))
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/**
 * A repeating-key XOR over a byte stream. The key position carries across
 * chunks, so the output is the same however the body was split.
 */
function xorStream(
  key: Uint8Array,
): TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>> {
  let position = 0
  return new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) {
      const out = new Uint8Array(chunk.length)
      for (let i = 0; i < chunk.length; i++) {
        out[i] = chunk[i]! ^ key[position++ % key.length]!
      }
      controller.enqueue(out)
    },
  })
}
