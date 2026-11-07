/**
 * The proxy tier picker.
 *
 * The source proxies and the GraphQL relay need no sign-in, so they are what
 * stops a scraper using this deployment as a free relay. They are tiered:
 * anonymous callers share a budget per address (`RATE_PROXY`), a signed-in
 * reader gets a larger one keyed by account (`RATE_PROXY_USER`), and a Sync
 * plan subscriber the largest (`RATE_PROXY_PAID`). The sync and billing routes
 * use one pre-auth bucket per address (`RATE_API`), charged by
 * `Auth.requireUserId`, so a flood never reaches Clerk, D1 or Polar.
 *
 * The bindings and their budgets are the `RateLimits` service; this is the
 * decision about which one a proxy request is charged to.
 */

import * as Effect from 'effect/Effect'

import { Auth } from './effect/auth'
import { RateLimits } from './effect/rate-limits'
import { readEntitlement } from './polar'

/**
 * Entitlement, cached per isolate.
 *
 * A D1 read per page image would be the most expensive thing on the hottest
 * path, so the answer is held for a few minutes. A subscription that starts
 * or lapses reaches the proxies within that window.
 *
 * Bounded and swept on write. An expired entry is otherwise only replaced
 * when that same reader returns, so without this the map keeps one entry per
 * account the isolate has ever served rather than per account it is actually
 * holding an answer for.
 */
const ENTITLEMENT_TTL_MS = 5 * 60 * 1000

const ENTITLEMENT_CACHE_MAX = 500

const entitlementCache = new Map<string, { active: boolean; expiresAt: number }>()

const isSubscribed = Effect.fn('rateLimit.isSubscribed')(function* (userId: string) {
  const now = Date.now()
  const held = entitlementCache.get(userId)
  if (held && held.expiresAt > now) return held.active

  // No DB, or a failed read: treated as unpaid, and asked again next time.
  const entitlement = yield* readEntitlement(userId).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (entitlement === undefined) return false

  const active = entitlement?.active ?? false
  for (const [account, entry] of entitlementCache) {
    if (entry.expiresAt <= now) entitlementCache.delete(account)
  }
  if (entitlementCache.size >= ENTITLEMENT_CACHE_MAX) {
    const oldest = entitlementCache.keys().next()
    if (!oldest.done) entitlementCache.delete(oldest.value)
  }
  entitlementCache.set(userId, { active, expiresAt: now + ENTITLEMENT_TTL_MS })
  return active
})

/**
 * Anything short of a valid session counts as anonymous. A session the app
 * has not refreshed yet, a build without Clerk, or a verification error all
 * degrade to the address budget rather than refusing the request.
 */
const sessionUserId = Effect.fn('rateLimit.sessionUserId')(function* (request: Request) {
  const auth = yield* Auth
  if (!(yield* auth.configured)) return null
  return yield* auth
    .authenticatedUserId(request)
    .pipe(Effect.catch(() => Effect.succeed(null)))
})

/**
 * The proxy check: picks the tier from the session cookie and the cached
 * entitlement, then charges that bucket. Null when allowed, a 429 otherwise.
 */
export const rateLimitProxy = Effect.fn('rateLimit.proxy')(function* (request: Request) {
  const rateLimits = yield* RateLimits
  const address = request.headers.get('cf-connecting-ip') ?? 'unknown'

  const userId = yield* sessionUserId(request)
  if (!userId) return yield* rateLimits.limit('RATE_PROXY', address)

  const bucket = (yield* isSubscribed(userId)) ? 'RATE_PROXY_PAID' : 'RATE_PROXY_USER'
  return yield* rateLimits.limit(bucket, userId)
})
