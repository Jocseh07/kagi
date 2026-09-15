/**
 * Per-address budgets for the public surface, backed by Cloudflare's Workers
 * Rate Limiting binding.
 *
 * Two buckets: `RATE_PROXY` for the source proxies and the GraphQL relay,
 * which anyone can call without signing in, and `RATE_API` for the sync and
 * billing routes, checked before a token is verified so a flood never reaches
 * Clerk, D1 or Polar. Limits live in wrangler config, not here.
 *
 * Keyed on `cf-connecting-ip`, which Cloudflare sets and a client cannot
 * forge. Readers behind one NAT share a budget. The counters are approximate
 * and per data centre, which is enough to make the deployment useless as a
 * free proxy at scale without ever touching a real reader.
 *
 * A deployment without the bindings is not throttled: the template must keep
 * working as-is, so the check fails open and says so once per isolate.
 */

import { env } from 'cloudflare:workers'
import type { RateLimit } from '@cloudflare/workers-types'

type Bucket = 'RATE_PROXY' | 'RATE_API'

/** Seconds a refused caller is told to wait; matches each binding's period. */
const RETRY_AFTER: Record<Bucket, string> = {
  RATE_PROXY: '10',
  RATE_API: '60',
}

const warned = new Set<Bucket>()

/** Null when allowed, a 429 when the caller's budget for this bucket is spent. */
export async function rateLimited(
  request: Request,
  bucket: Bucket,
): Promise<Response | null> {
  const limiter = (env as Partial<Record<Bucket, RateLimit>>)[bucket]
  if (!limiter) {
    if (!warned.has(bucket)) {
      warned.add(bucket)
      console.warn(`${bucket} binding is unset; requests are not rate limited.`)
    }
    return null
  }

  const key = request.headers.get('cf-connecting-ip') ?? 'unknown'
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
