/**
 * Service worker for offline reading.
 *
 * A page image is stored in the Cache API and handed straight back to an
 * `<img>`. That is the whole mechanism behind saved chapters.
 *
 * Every remote source is now proxied through the app's own origin, so its
 * images arrive same-origin and readable, and are counted as they are stored:
 * see `measureBytes`. The opaque path below is kept because it is not dead —
 * a chapter saved before a source was proxied still holds cross-origin URLs,
 * and those entries stay opaque and uncountable for as long as they are kept.
 *
 * Plain JS on purpose: this file is served verbatim out of `public/`, so it is
 * never bundled and cannot import from `src/`.
 */

/*
 * Source of truth for these names is `src/lib/offline/types.ts`
 * (PAGE_CACHE / SHELL_CACHE). They are duplicated here because a `public/`
 * file has no build step to import through. Change both together.
 */
const PAGE_CACHE = 'page-images-v1'
const SHELL_CACHE = 'app-shell-v1'

/*
 * Outcomes of background fetches, keyed by registration id.
 *
 * A background fetch outlives the page that started it — that is the entire
 * point of it — so its per-URL results have to be left somewhere the next page
 * load can find them. The Cache API is the only store this worker already
 * depends on, so a small JSON response per run is kept here rather than pulling
 * in IndexedDB for a handful of rows.
 */
const BG_RESULT_CACHE = 'background-fetch-results-v1'
const CURRENT_CACHES = [PAGE_CACHE, SHELL_CACHE, BG_RESULT_CACHE]

/*
 * Only the entry document is precached. Built asset filenames are content
 * hashed and unknown when this file is authored, and hardcoding them would
 * mean editing the worker on every build. The hashed `/assets/*` files are
 * picked up by the stale-while-revalidate rule below on the first visit, which
 * is enough: the shell that the first load pulls in is exactly the shell that
 * later offline loads need.
 *
 * `/` is the only entry, and `/index.html` is deliberately not listed beside
 * it: under TanStack Start the shell is served by the Worker at whatever path
 * was asked for, and there is no `/index.html` file to fetch — it 404s. That
 * matters more than it looks, because `addAll` is atomic, so one missing URL
 * would fail the install and leave the app with no service worker at all.
 */
const SHELL_URLS = ['/']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names
          .filter((name) => !CURRENT_CACHES.includes(name))
          .map((name) => caches.delete(name)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  let url
  try {
    url = new URL(request.url)
  } catch {
    return
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return

  const sameOrigin = url.origin === self.location.origin

  // Deep links must resolve to the SPA shell when the network is gone.
  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request))
    return
  }

  if (sameOrigin && url.pathname.startsWith('/assets/')) {
    event.respondWith(staleWhileRevalidate(event, request))
    return
  }

  // Saved pages are matched by URL, not by origin. Every remote source is
  // proxied through this origin (`/asuracdn`, `/thunderscans`, `/fenrirealm`,
  // `/mangadot`, `/weebcdn`, `/flamecdn`, `/katanacdn`, `/mdimage`,
  // `/comickcdn`, `/toonilycdn`, `/webtoonscdn`, `/mangapluscdn`), so their
  // page images are same-origin and an origin test here would skip exactly the
  // chapters the user asked to keep. A same-origin image that was never saved
  // simply misses and falls through to the network.
  if (request.destination === 'image') {
    event.respondWith(cachedPageOrNetwork(request))
    return
  }

  // Everything else falls through to the browser untouched. In particular the
  // source APIs — same-origin now that Asura is proxied too — are owned by
  // TanStack Query and by the upstream's own `cache-control`, which the proxy
  // forwards; caching them here would only fight both.
})

/** Network first, cached shell second, so a fresh deploy is picked up. */
async function navigationResponse(request) {
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE)
      // Stored under `/` rather than under the path that was navigated to:
      // every deep link is answered with the same shell, so keying by request
      // would store one identical copy per route the user has ever visited.
      await cache.put('/', response.clone())
    }
    return response
  } catch (error) {
    const cache = await caches.open(SHELL_CACHE)
    const cached = await cache.match('/')
    if (cached) return cached
    throw error
  }
}

async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(SHELL_CACHE)
  const cached = await cache.match(request)

  const network = fetch(request)
    .then((response) => {
      // Hashed assets are immutable, but a 404 or an opaque redirect must not
      // be allowed to poison the shell cache.
      if (response.ok && response.type === 'basic') {
        return cache.put(request, response.clone()).then(() => response)
      }
      return response
    })
    .catch(() => undefined)

  if (cached) {
    event.waitUntil(network)
    return cached
  }

  const response = await network
  if (response) return response
  return new Response('Asset unavailable offline', {
    status: 504,
    statusText: 'Gateway Timeout',
  })
}

/**
 * Cache first, and deliberately *no write on a miss*.
 *
 * Chrome pads every stored opaque response to ~7 MB for quota accounting, so
 * passively caching each page a reader scrolls past would burn roughly 7 MB of
 * the origin's quota per page and evict the chapters the user actually asked
 * to keep. Only the explicit save flow (CACHE_PAGES below) writes to
 * PAGE_CACHE. A miss is re-issued as the original request object, so mode,
 * credentials and referrer policy are exactly what the page asked for.
 *
 * The origin is deliberately no part of the test: a proxied source's pages are
 * same-origin, and they are saved chapters like any other.
 */
async function cachedPageOrNetwork(request) {
  const cache = await caches.open(PAGE_CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  return fetch(request)
}

self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || typeof data !== 'object') return
  const port = event.ports && event.ports[0]

  switch (data.type) {
    case 'SKIP_WAITING':
      event.waitUntil(
        self.skipWaiting().then(() => reply(port, { type: 'SKIP_WAITING_RESULT' })),
      )
      return
    case 'CACHE_PAGES':
      event.waitUntil(
        cachePages(
          toUrlList(data.urls),
          port,
          toInterval(data.minIntervalMs),
          typeof data.token === 'string' ? data.token : null,
        ),
      )
      return
    case 'CACHE_PAGES_CANCEL':
      if (typeof data.token === 'string') cancelledRuns.add(data.token)
      return
    case 'DELETE_PAGES':
      event.waitUntil(deletePages(toUrlList(data.urls), port))
      return
    case 'CACHED_URLS':
      event.waitUntil(cachedUrls(toUrlList(data.urls), port))
      return
    case 'BACKGROUND_FETCH_RESULT':
      event.waitUntil(
        readBackgroundResult(data.id).then((result) =>
          reply(port, { type: 'BACKGROUND_FETCH_RESULT_REPLY', result }),
        ),
      )
      return
    case 'BACKGROUND_FETCH_CLEAR':
      event.waitUntil(
        clearBackgroundResult(data.id).then(() =>
          reply(port, { type: 'BACKGROUND_FETCH_CLEAR_RESULT' }),
        ),
      )
      return
    default:
      return
  }
})

function toUrlList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((entry) => typeof entry === 'string' && entry.length > 0)
}

function reply(port, message) {
  if (port) port.postMessage(message)
}

function describeError(error) {
  if (error && typeof error === 'object' && 'name' in error) {
    return { name: String(error.name), message: String(error.message ?? error.name) }
  }
  return { name: 'Error', message: String(error) }
}

/**
 * Pause between page fetches, in milliseconds.
 *
 * These fetches bypass the app's own RateLimiter entirely, because they happen
 * here rather than through the source's HttpTransport. Without pacing a 40-page
 * chapter would outrun whatever the image host tolerates and risk getting the
 * reader blocked. The caller passes the source's own `pageFetchIntervalMs`,
 * which is the figure that knows what host the images actually come from; this
 * default is the conservative fallback for callers that don't.
 */
const DEFAULT_PAGE_FETCH_INTERVAL_MS = 1100

/**
 * Pages in flight at once per chapter. Fetched one at a time, a chapter was
 * held to under 1 MB/s regardless of the connection; a handful in parallel
 * fills the pipe while `takeTurn` still bounds the request rate per host.
 */
const PAGE_FETCH_CONCURRENCY = 6

function toInterval(value) {
  return typeof value === 'number' && value >= 0 && Number.isFinite(value)
    ? value
    : DEFAULT_PAGE_FETCH_INTERVAL_MS
}

const wait = (ms) =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()

/**
 * A page's real byte count, or null when there is none to be had.
 *
 * An opaque response is unreadable: `arrayBuffer()` yields nothing and the
 * headers are stripped, so there is no `content-length` either. Its real size
 * would be the wrong figure regardless — Chrome charges every opaque entry a
 * fixed padding against quota, which is what `OPAQUE_PADDING_BYTES` in
 * src/lib/offline/types.ts projects from.
 *
 * Sources proxied through this origin come back `basic` and readable, and cost
 * the quota exactly what they weigh. Those are the ones worth counting, and
 * counting them is what lets the caller drop its storage-estimate guesswork.
 *
 * Called before `cache.put`, which consumes the body the clone is taken from.
 */
async function measureBytes(response) {
  if (response.type === 'opaque') return null
  try {
    return (await response.clone().arrayBuffer()).byteLength
  } catch {
    // A body that will not buffer is not worth failing an otherwise good save
    // over; the caller falls back to its projection.
    return null
  }
}

/**
 * Chained pacing gates, one per upstream host.
 *
 * A rate limit belongs to the host, not to a run, and several CACHE_PAGES runs
 * can be in flight at once — the queue downloads as many chapters in parallel
 * as the user configured. A timestamp local to each run would let every run
 * pace itself correctly while the host saw the sum of them, so the wait is
 * chained here instead: each turn resolves at the moment its fetch may start,
 * and the next turn for that host waits from there.
 */
const originGates = new Map()

/**
 * Which gate a URL belongs to.
 *
 * The origin alone is wrong for this app: every proxied source resolves to
 * *this* origin, so Asura, Thunder, Mangadot and Fenrir would share one gate
 * and each would wait out the others' pacing while its own site sat idle. The
 * proxy prefix is the first path segment and names the upstream host, so
 * same-origin URLs are keyed on origin plus that segment. Cross-origin URLs
 * keep the origin alone, which is already the host.
 */
function gateKeyFor(url) {
  // A URL that will not parse cannot be grouped with anything, and keying on
  // the raw string just gives it a gate of its own.
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return url
  }

  if (parsed.origin !== self.location.origin) return parsed.origin

  const prefix = parsed.pathname.split('/')[1] ?? ''
  return `${parsed.origin}/${prefix}`
}

function takeTurn(url, minIntervalMs) {
  const key = gateKeyFor(url)

  const previous = originGates.get(key) ?? Promise.resolve(0)
  const turn = previous.then(async (previousFetchAt) => {
    if (previousFetchAt !== 0) {
      await wait(minIntervalMs - (Date.now() - previousFetchAt))
    }
    return Date.now()
  })
  originGates.set(key, turn)
  return turn
}

/**
 * Fetches each URL `no-cors` and stores the opaque result.
 *
 * `cache.add()`/`addAll()` cannot be used: they reject any response whose
 * status is outside 2xx, and an opaque response reports status 0. Explicit
 * fetch + `cache.put()` is the only path that works.
 *
 * An opaque response is unreadable, so a 404 HTML page is indistinguishable
 * from a real image here. Verification is the caller's job (it can load the
 * cached URL into an `Image` and check naturalWidth).
 *
 * Up to PAGE_FETCH_CONCURRENCY pages are in flight at once. Starts are still
 * paced by `takeTurn`, which spaces when a fetch may *begin* rather than
 * waiting for the previous one to finish, so the host sees a bounded request
 * rate while the pipe stays full. The gate is shared with any other run
 * against the same origin, so parallel chapters interleave inside the host's
 * rate rather than each claiming it. A progress message goes back after each
 * page, ahead of the single CACHE_PAGES_RESULT, so the caller can show the run
 * moving instead of a counter that only jumps at the end.
 */
/**
 * Tokens of CACHE_PAGES runs the page has asked to stop.
 *
 * A run cannot be aborted from outside once its loop is going, so the page
 * names each run with a token and sends CACHE_PAGES_CANCEL for it; the loop
 * checks the set before every fetch and every put. Tokens are removed when the
 * run replies, so the set never grows past the runs in flight.
 */
const cancelledRuns = new Set()

async function cachePages(urls, port, minIntervalMs, token) {
  const cache = await caches.open(PAGE_CACHE)
  const results = new Array(urls.length)
  let completed = 0
  let quotaExhausted = false
  let next = 0
  const cancelled = () => token !== null && cancelledRuns.has(token)

  const announce = () =>
    reply(port, {
      type: 'CACHE_PAGES_PROGRESS',
      completed,
      total: urls.length,
    })

  const cacheOne = async (index) => {
    const url = urls[index]
    if (quotaExhausted) {
      return { url, ok: false, error: 'QuotaExceededError', bytes: null }
    }
    // A page left behind by an interrupted run is kept, not refetched: the
    // save that owns it resumes from here instead of from the first page.
    const held = await cache.match(url)
    if (held) return { url, ok: true, bytes: await measureBytes(held) }
    if (cancelled()) return { url, ok: false, error: 'cancelled', bytes: null }
    await takeTurn(url, minIntervalMs)
    if (cancelled()) return { url, ok: false, error: 'cancelled', bytes: null }
    try {
      // `no-referrer` and `same-origin` mirror what the reader's <img> sends,
      // so the CDN sees the request shape it already serves and the proxies
      // see the session cookie they tier on.
      const response = await fetch(url, {
        mode: 'no-cors',
        credentials: 'same-origin',
        referrerPolicy: 'no-referrer',
      })

      // Opaque responses (status 0) are expected here and fine. A readable
      // response that is an outright error is not worth storing.
      if (response.type !== 'opaque' && !response.ok) {
        return { url, ok: false, error: `HTTP ${response.status}`, bytes: null }
      }
      const bytes = await measureBytes(response)
      if (cancelled()) return { url, ok: false, error: 'cancelled', bytes: null }
      await cache.put(url, response)
      return { url, ok: true, bytes }
    } catch (error) {
      const described = describeError(error)
      // Once the origin is out of quota every later put fails too; stop
      // hammering the CDN and report the rest as the same failure.
      if (described.name === 'QuotaExceededError') quotaExhausted = true
      return {
        url,
        ok: false,
        error:
          described.name === 'QuotaExceededError'
            ? 'QuotaExceededError'
            : described.message,
        bytes: null,
      }
    }
  }

  const drain = async () => {
    while (next < urls.length) {
      const index = next++
      results[index] = await cacheOne(index)
      completed++
      announce()
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(PAGE_FETCH_CONCURRENCY, urls.length) }, drain),
  )

  if (token !== null) cancelledRuns.delete(token)
  reply(port, { type: 'CACHE_PAGES_RESULT', results })
}

// ------------------------------------------------------- background fetch --

/*
 * Background Fetch is what makes a download survive the app being hidden,
 * backgrounded, or closed outright: the browser owns the transfer, shows it in
 * the system download UI, and wakes this worker when it settles. Everything
 * below is the settling half — the run itself is registered by the page, in
 * `src/lib/offline/background-fetch.ts`, because the page can hold a live
 * reference to it and report progress from there.
 *
 * The bytes only become a saved chapter here. `record.responseReady` is where
 * an opaque page image finally materialises, and putting it into PAGE_CACHE is
 * the same write `cachePages` does; nothing else about a saved chapter changes.
 */

const BG_RESULT_PREFIX = '/__background-fetch__/'

function bgResultKey(id) {
  return new URL(BG_RESULT_PREFIX + encodeURIComponent(String(id)), self.location.origin)
    .href
}

async function storeBackgroundResult(id, payload) {
  const cache = await caches.open(BG_RESULT_CACHE)
  await cache.put(
    bgResultKey(id),
    new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json' },
    }),
  )
}

async function readBackgroundResult(id) {
  if (typeof id !== 'string' || id.length === 0) return null
  const cache = await caches.open(BG_RESULT_CACHE)
  const match = await cache.match(bgResultKey(id))
  if (!match) return null
  try {
    return await match.json()
  } catch {
    return null
  }
}

async function clearBackgroundResult(id) {
  if (typeof id !== 'string' || id.length === 0) return
  const cache = await caches.open(BG_RESULT_CACHE)
  await cache.delete(bgResultKey(id))
}

/**
 * Moves a settled run's downloads into the page cache, one record at a time.
 *
 * Called for failures too: a run that fetched 38 of 40 pages still holds 38
 * usable records, and the caller decides what a partial run is worth. A record
 * whose download failed rejects `responseReady`, which is how it is told apart.
 */
async function harvestBackgroundFetch(registration) {
  const records = await registration.matchAll()
  const cache = await caches.open(PAGE_CACHE)
  const results = []
  let quotaExhausted = false

  for (const record of records) {
    const url = record.request.url
    if (quotaExhausted) {
      results.push({ url, ok: false, error: 'QuotaExceededError', bytes: null })
      continue
    }
    try {
      const response = await record.responseReady
      // Opaque responses (status 0) are the normal case for page images.
      if (response.type !== 'opaque' && !response.ok) {
        results.push({
          url,
          ok: false,
          error: `HTTP ${response.status}`,
          bytes: null,
        })
        continue
      }
      const bytes = await measureBytes(response)
      await cache.put(url, response)
      results.push({ url, ok: true, bytes })
    } catch (error) {
      const described = describeError(error)
      const quota = described.name === 'QuotaExceededError'
      if (quota) quotaExhausted = true
      results.push({
        url,
        ok: false,
        error: quota ? 'QuotaExceededError' : described.message,
        bytes: null,
      })
    }
  }

  return results
}

async function settleBackgroundFetch(event, outcome) {
  const registration = event.registration
  const results =
    outcome === 'aborted' ? [] : await harvestBackgroundFetch(registration)
  await storeBackgroundResult(registration.id, { outcome, results })
  await announceBackgroundFetch(registration.id)
  return results
}

/**
 * Nudges any live page, so a run that settles while the app is open is picked
 * up at once instead of on the next poll. A page that is gone hears nothing and
 * reads the stored result when it comes back.
 */
async function announceBackgroundFetch(id) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true })
  for (const client of clients) {
    client.postMessage({ type: 'BACKGROUND_FETCH_SETTLED', id })
  }
}

self.addEventListener('backgroundfetchsuccess', (event) => {
  event.waitUntil(
    (async () => {
      const results = await settleBackgroundFetch(event, 'success')
      const failed = results.filter((entry) => !entry.ok).length
      try {
        // Only meaningful inside this handler, and unsupported in some builds.
        await event.updateUI({
          title:
            failed === 0
              ? 'Chapter downloaded'
              : `Chapter downloaded with ${failed} failed pages`,
        })
      } catch {
        // Cosmetic. The pages are cached either way.
      }
    })(),
  )
})

self.addEventListener('backgroundfetchfail', (event) => {
  event.waitUntil(
    (async () => {
      await settleBackgroundFetch(event, 'failure')
      try {
        await event.updateUI({ title: 'Chapter download failed' })
      } catch {
        // Cosmetic, as above.
      }
    })(),
  )
})

self.addEventListener('backgroundfetchabort', (event) => {
  event.waitUntil(settleBackgroundFetch(event, 'aborted'))
})

/** Tapping the system download notification opens the queue. */
self.addEventListener('backgroundfetchclick', (event) => {
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      const open = clients[0]
      if (open) {
        await open.focus()
        return
      }
      await self.clients.openWindow('/downloads')
    })(),
  )
})

async function deletePages(urls, port) {
  const cache = await caches.open(PAGE_CACHE)
  const results = []
  for (const url of urls) {
    try {
      results.push({ url, ok: await cache.delete(url) })
    } catch {
      results.push({ url, ok: false })
    }
  }
  reply(port, { type: 'DELETE_PAGES_RESULT', results })
}

async function cachedUrls(urls, port) {
  const cache = await caches.open(PAGE_CACHE)
  const present = []
  for (const url of urls) {
    const match = await cache.match(url)
    if (match) present.push(url)
  }
  reply(port, { type: 'CACHED_URLS_RESULT', present })
}
