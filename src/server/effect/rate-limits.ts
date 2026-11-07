/**
 * Per-caller budgets, backed by Cloudflare's Workers Rate Limiting bindings.
 *
 * Limits live in alchemy.run.ts, not here. `cf-connecting-ip` is set by
 * Cloudflare and cannot be forged; counters are approximate and per data
 * centre, which is enough here.
 *
 * A deployment without a binding is not throttled on that tier: the template
 * must keep working as-is, so the check fails open and says so once per
 * isolate.
 */

import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { Env } from './env'

export type Bucket = 'RATE_PROXY' | 'RATE_PROXY_USER' | 'RATE_PROXY_PAID' | 'RATE_API'

/** Seconds a refused caller is told to wait; matches each binding's period. */
const RETRY_AFTER: Record<Bucket, string> = {
  RATE_PROXY: '10',
  RATE_PROXY_USER: '10',
  RATE_PROXY_PAID: '10',
  RATE_API: '60',
}

const warned = new Set<Bucket>()

export interface RateLimitsShape {
  /** Null when allowed, a 429 when the caller's budget for this bucket is spent. */
  readonly limit: (bucket: Bucket, key: string) => Effect.Effect<Response | null>
}

export class RateLimits extends Context.Service<RateLimits, RateLimitsShape>()(
  'kagi/RateLimits',
) {
  static readonly layer = Layer.effect(
    RateLimits,
    Effect.gen(function* () {
      const env = yield* Env

      const limit = (bucket: Bucket, key: string) =>
        Effect.suspend(() => {
          const limiter = env[bucket]
          if (!limiter) {
            if (!warned.has(bucket)) {
              warned.add(bucket)
              console.warn(`${bucket} binding is unset; requests are not rate limited.`)
            }
            return Effect.succeed(null)
          }
          return Effect.promise(() => limiter.limit({ key })).pipe(
            Effect.map(({ success }) =>
              success
                ? null
                : new Response('Too many requests', {
                    status: 429,
                    headers: {
                      'retry-after': RETRY_AFTER[bucket],
                      'content-type': 'text/plain; charset=utf-8',
                    },
                  }),
            ),
          )
        })

      return { limit } satisfies RateLimitsShape
    }),
  ).pipe(Layer.provide(Env.layer))
}
