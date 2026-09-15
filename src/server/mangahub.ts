/**
 * MangaHub's GraphQL API, reached from the server because a browser cannot.
 *
 * Three things gate `api.mghcdn.com/graphql`, and all three were measured
 * rather than inferred. It answers a plain **404** — not a 401 — when any of
 * them is missing, so a failure here looks like a wrong URL rather than a
 * refusal:
 *
 *  - the request is a **POST** carrying the query as JSON;
 *  - it carries an **`Origin` naming the site**. `Origin: http://localhost:5173`
 *    is refused, which rules out calling it from the page even though the
 *    response does send CORS headers;
 *  - it carries **`x-mhub-access`**, a key the site hands out as a cookie on
 *    any page load. Keys are per-visit and last 100 days; several are valid at
 *    once, so harvesting a fresh one never invalidates the one in flight.
 *
 * The key is also what the API meters. Its budget is a few hundred queries,
 * after which it answers "API rate limit excessed!" — as a GraphQL error
 * inside an HTTP 200, so nothing about the response status says so. The remedy
 * is a fresh key, which is what a reader clicking through to `mangahub.io`
 * would get and what `mangahubGraphql` does on the reader's behalf.
 *
 * The site itself is never proxied — this route exists only to satisfy those
 * three — and the page images are not proxied either: `imgx.mghcdn.com`
 * reflects the request origin, so the reader fetches them directly and their
 * bytes stay readable.
 */

/** The MangaHub property this source reads. Also the `Origin` the API wants. */
const SITE_URL = 'https://mangakakalot.fun'

const API_URL = 'https://api.mghcdn.com/graphql'

const ACCESS_HEADER = 'x-mhub-access'

/** The cookie the site sets on any page load. */
const ACCESS_COOKIE = /mhub_access=([0-9a-f]+)/

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * The largest query this route will forward. The biggest one the source sends
 * is a series lookup at roughly 200 bytes; 4 KB is generous and still small
 * enough that the route cannot be used to push a payload upstream.
 */
const MAX_BODY_BYTES = 4096

/**
 * The access key, held per isolate.
 *
 * A key outlives the isolate that fetched it by a wide margin, so this is
 * effectively one extra request per cold start rather than per call.
 */
let cachedKey: string | null = null

export async function mangahubGraphql(request: Request): Promise<Response> {
  const body = await request.text()
  if (body.length > MAX_BODY_BYTES) {
    return new Response('Query is too large', { status: 413 })
  }
  if (!isGraphqlQuery(body)) {
    return new Response('Body is not a GraphQL query', { status: 400 })
  }

  let answer = await ask(body, await accessKey())

  // Both ways a key goes bad are answered here: a rejected or expired one
  // brings back a 404, and a spent one brings back a rate-limit error with a
  // 200. Either way the key is replaced and the query asked again once, which
  // is the whole remedy — a fresh key starts with a fresh budget.
  if (answer.status === 404 || isRateLimited(answer.text)) {
    cachedKey = null
    answer = await ask(body, await accessKey())
  }

  if (answer.status !== 200) {
    return new Response('MangaHub refused the query', { status: 502 })
  }

  // No `Cache-Control`: listings and chapter lists are exactly the things that
  // change, and the app already caches what it wants to keep.
  return new Response(answer.text, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * One query, with its body read.
 *
 * The reply is buffered rather than streamed because the rate-limit refusal is
 * only visible in it. The largest of them is a chapter list, which for a
 * 913-chapter series is around 60 KB.
 */
async function ask(
  body: string,
  key: string,
): Promise<{ status: number; text: string }> {
  const upstream = await post(body, key)
  return { status: upstream.status, text: await upstream.text() }
}

/**
 * Whether the reply is the spent-key refusal.
 *
 * Matched on the message because there is nothing else to match on: it arrives
 * as an ordinary GraphQL error under HTTP 200. The site's own spelling of
 * "excessed" is not reproduced here; only the stable part is.
 */
function isRateLimited(text: string): boolean {
  return text.includes('"errors"') && /rate limit/i.test(text)
}

function post(body: string, key: string): Promise<Response> {
  return fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      Origin: SITE_URL,
      Referer: `${SITE_URL}/`,
      [ACCESS_HEADER]: key,
    },
    body,
  })
}

async function accessKey(): Promise<string> {
  if (cachedKey) return cachedKey

  const res = await fetch(`${SITE_URL}/`, {
    headers: { 'User-Agent': USER_AGENT },
  })
  const cookies = res.headers.getSetCookie().join('; ')
  await res.body?.cancel()

  const key = ACCESS_COOKIE.exec(cookies)?.[1]
  if (!key) throw new Error('MangaHub served no access key.')

  cachedKey = key
  return key
}

/**
 * Whether the body is a GraphQL query document and nothing else.
 *
 * The upstream is fixed, so this is not what keeps the route from becoming an
 * open relay; it is what keeps a malformed request from being answered with
 * MangaHub's 404 page instead of a readable error.
 */
function isGraphqlQuery(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body)
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { query?: unknown }).query === 'string'
    )
  } catch {
    return false
  }
}
