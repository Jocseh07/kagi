/**
 * Per-caller budgets for the public surface, backed by Cloudflare's Workers
 * Rate Limiting binding.
 *
 * The source proxies and the GraphQL relay need no sign-in, so they are what
 * stops a scraper using this deployment as a free relay. They are tiered:
 * anonymous callers share a budget per address (`RATE_PROXY`), a signed-in
 * reader gets a larger one keyed by account (`RATE_PROXY_USER`), and a Sync
 * plan subscriber the largest (`RATE_PROXY_PAID`). The sync and billing
 * routes use one pre-auth bucket per address (`RATE_API`) so a flood never
 * reaches Clerk, D1 or Polar. Limits live in wrangler config, not here.
 *
 * `cf-connecting-ip` is set by Cloudflare and cannot be forged. Counters are
 * approximate and per data centre, which is enough here.
 *
 * A deployment without a binding is not throttled on that tier: the template
 * must keep working as-is, so the check fails open and says so once per
 * isolate.
 */

import { env } from 'cloudflare:workers'
import type { RateLimit } from '@cloudflare/workers-types'

import { authenticatedUserId, clerkConfigured } from './auth'
import { syncDb } from './db'
import { readEntitlement } from './polar'

type Bucket = 'RATE_PROXY' | 'RATE_PROXY_USER' | 'RATE_PROXY_PAID' | 'RATE_API'

/** Seconds a refused caller is told to wait; matches each binding's period. */
const RETRY_AFTER: Record<Bucket, string> = {
  RATE_PROXY: '10',
  RATE_PROXY_USER: '10',
  RATE_PROXY_PAID: '10',
  RATE_API: '60',
}

const warned = new Set<Bucket>()

/** Null when allowed, a 429 when the caller's budget for this bucket is spent. */
export async function rateLimited(
  request: Request,
  bucket: Bucket,
  key = request.headers.get('cf-connecting-ip') ?? 'unknown',
): Promise<Response | null> {
  const limiter = (env as Partial<Record<Bucket, RateLimit>>)[bucket]
  if (!limiter) {
    if (!warned.has(bucket)) {
      warned.add(bucket)
      console.warn(`${bucket} binding is unset; requests are not rate limited.`)
    }
    return null
  }

  const { success } = await limiter.limit({ key })
  if (success) return null

  return new Response('Too many requests', {
    status: 429,
    headers: {
      'retry-after': RETRY_AFTER[bucket],
      'content-type': 'text/plain; charset=utf-8',
    },
  })
}

/**
 * The proxy check: picks the tier from the session cookie and the cached
 * entitlement, then charges that bucket.
 *
 * Anything short of a valid session counts as anonymous. A session the app
 * has not refreshed yet, a build without Clerk, or a verification error all
 * degrade to the address budget rather than refusing the request.
 */
export async function rateLimitProxy(request: Request): Promise<Response | null> {
  const userId = await sessionUserId(request)
  if (!userId) return rateLimited(request, 'RATE_PROXY')
  const bucket = (await isSubscribed(userId)) ? 'RATE_PROXY_PAID' : 'RATE_PROXY_USER'
  return rateLimited(request, bucket, userId)
}

async function sessionUserId(request: Request): Promise<string | null> {
  if (!clerkConfigured()) return null
  try {
    return await authenticatedUserId(request)
  } catch {
    return null
  }
}

/**
 * Entitlement, cached per isolate.
 *
 * A D1 read per page image would be the most expensive thing on the hottest
 * path, so the answer is held for a few minutes. A subscription that starts
 * or lapses reaches the proxies within that window.
 */
const ENTITLEMENT_TTL_MS = 5 * 60 * 1000

const entitlementCache = new Map<string, { active: boolean; expiresAt: number }>()

async function isSubscribed(userId: string): Promise<boolean> {
  const now = Date.now()
  const held = entitlementCache.get(userId)
  if (held && held.expiresAt > now) return held.active

  let active = false
  try {
    active = (await readEntitlement(syncDb(), userId))?.active ?? false
  } catch {
    // No DB, or a failed read: treated as unpaid, and asked again next time.
    return false
  }
  entitlementCache.set(userId, { active, expiresAt: now + ENTITLEMENT_TTL_MS })
  return active
}
