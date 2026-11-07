/**
 * Bindings and secrets for the current request.
 *
 * The one module that imports `cloudflare:workers`. Nothing that runs in the
 * browser may reach it, which is why `AppError` lives in errors.ts. The module
 * is loaded lazily because the SPA-shell prerender runs outside workerd, where
 * the specifier cannot resolve. Reads are deferred to property access too:
 * TanStack Start's dev server evaluates modules outside a request, where the
 * top-level `env` is not yet populated.
 *
 * Keep this in step with the `env` block in alchemy.run.ts.
 */

import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import type * as CloudflareWorkers from 'cloudflare:workers'
import type { D1Database, R2Bucket, RateLimit } from '@cloudflare/workers-types'

export interface KagiEnv {
  /** The sync database. */
  DB?: D1Database
  /** Signed Android builds and their `latest.json`. */
  RELEASES?: R2Bucket
  APP_RELEASE_ID?: string
  /** Per-address budget for anonymous calls to the source proxies. */
  RATE_PROXY?: RateLimit
  /** Per-account budget for signed-in, unsubscribed readers on the proxies. */
  RATE_PROXY_USER?: RateLimit
  /** Per-account budget for Sync plan subscribers on the proxies. */
  RATE_PROXY_PAID?: RateLimit
  /** Per-address budget for the sync and billing routes, checked before auth. */
  RATE_API?: RateLimit
  /** Public by design; also baked into the client bundle. */
  CLERK_PUBLISHABLE_KEY?: string
  CLERK_SECRET_KEY?: string
  /** The PEM public key, for networkless token verification. */
  CLERK_JWT_KEY?: string
  /** Comma-separated origins allowed to mint tokens. */
  CLERK_AUTHORIZED_PARTIES?: string
  POLAR_ACCESS_TOKEN?: string
  POLAR_WEBHOOK_SECRET?: string
  POLAR_PRODUCT_ID?: string
  /** `sandbox` or `production`. */
  POLAR_SERVER?: string
  /** This deployment's public origin, for the outbound User-Agent contact. */
  APP_ORIGIN?: string
  /**
   * Extends the request's lifetime past the response. The proxy's cache write
   * uses it so the first reader of an image is not made to wait for the colo
   * to finish storing it. Lives on the service so `cloudflare:workers` keeps
   * exactly one importer.
   */
  waitUntil: (promise: Promise<unknown>) => void
}

const cloudflareWorkers: Promise<typeof CloudflareWorkers> = import(
  'cloudflare:workers'
).catch(
  () => ({ env: {}, waitUntil: () => {} }),
)

export class Env extends Context.Service<Env, KagiEnv>()('kagi/Env') {
  static readonly layer = Layer.effect(
    Env,
    Effect.map(
      Effect.promise(() => cloudflareWorkers),
      (cf) =>
        new Proxy({} as KagiEnv, {
          get(_, prop) {
            if (prop === 'waitUntil') return cf.waitUntil
            const value = (cf.env as Record<string | symbol, unknown>)[prop]
            return value === '' ? undefined : value
          },
        }),
    ),
  )
}
