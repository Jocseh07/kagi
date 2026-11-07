/**
 * The whole deployment, as code.
 *
 * This file is committed to a public repository, so it holds no deployment
 * values: the hostname, the Clerk instance, the Polar wiring and every secret
 * are read from the environment. `.env` drives `bun run dev`, `.env.prod` drives
 * `bun run deploy`, and `.env.example` is the template for both.
 *
 * The two literals here are the D1 database name, which is what Alchemy adopts
 * an existing database by, and the releases bucket name, which the mobile
 * app's release scripts upload to.
 */

import * as Alchemy from 'alchemy'
import * as Cloudflare from '@alchemy.run/cloudflare'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'

// A stack cannot be built without a hostname, so an unset APP_DOMAIN is a
// defect rather than a failure the resource graph would have to carry.
const domain = Config.String('APP_DOMAIN').pipe(Effect.orDie)

export const Database = Cloudflare.D1.Database('Database', {
  name: 'kagi-sync',
  // Flat NNNN_name.sql, which is what D1 already records as applied.
  // drizzle-kit's own state stays in ./drizzle; see drizzle.config.ts.
  migrations: './migrations',
})

/**
 * Signed Android builds, uploaded by the mobile app's `release:android` script
 * and served by /download/android. The bucket is private: only the Worker reads it.
 */
export const Releases = Cloudflare.R2.Bucket('Releases', { name: 'kagi-releases' })

/**
 * Request budgets, enforced in src/server/effect/rate-limits.ts. The proxies
 * need no sign-in, so these are what stop a scraper using a deployment as a
 * free relay: RATE_PROXY per address for anonymous callers, RATE_PROXY_USER
 * per account for signed-in readers, RATE_PROXY_PAID per account for Sync
 * plan subscribers, and RATE_API per address in front of the sync and billing
 * routes. `namespaceId` is any integer unique within your account; `period` is
 * 10 or 60 seconds. Counters are approximate and per data centre.
 */
export const RateProxy = Cloudflare.RateLimit('RATE_PROXY', {
  namespaceId: 1001,
  simple: { limit: 200, period: 10 },
})

export const RateProxyUser = Cloudflare.RateLimit('RATE_PROXY_USER', {
  namespaceId: 1003,
  simple: { limit: 300, period: 10 },
})

export const RateProxyPaid = Cloudflare.RateLimit('RATE_PROXY_PAID', {
  namespaceId: 1004,
  simple: { limit: 600, period: 10 },
})

export const RateApi = Cloudflare.RateLimit('RATE_API', {
  namespaceId: 1002,
  simple: { limit: 60, period: 60 },
})

/**
 * The hostname is bound to this script name. Renaming `name` creates a
 * different Worker and leaves the domain on the old one.
 *
 * Every Clerk and Polar value defaults to empty: without them the app is still
 * a working offline reader, and sign-in and sync simply refuse. `workersDev`
 * is off so the app has exactly one origin — CLERK_AUTHORIZED_PARTIES names
 * that origin alone, so a second workers.dev copy could not sign in anyway.
 */
export const Website = Cloudflare.Website.Vite(
  'Website',
  Effect.map(domain, (host) => ({
    name: 'kagi',
    main: 'src/server.ts',
    domain: host,
    workersDev: false,
    compatibility: { date: '2026-08-25' },
    observability: { enabled: true },
    dev: { port: 3150, strictPort: true },
    env: {
      DB: Database,
      RELEASES: Releases,
      RATE_PROXY: RateProxy,
      RATE_PROXY_USER: RateProxyUser,
      RATE_PROXY_PAID: RateProxyPaid,
      RATE_API: RateApi,
      VITE_CLERK_PUBLISHABLE_KEY: Config.String('VITE_CLERK_PUBLISHABLE_KEY').pipe(
        Config.withDefault(''),
      ),
      CLERK_PUBLISHABLE_KEY: Config.String('CLERK_PUBLISHABLE_KEY').pipe(
        Config.withDefault(''),
      ),
      CLERK_SECRET_KEY: Config.Redacted('CLERK_SECRET_KEY').pipe(Config.withDefault('')),
      CLERK_JWT_KEY: Config.Redacted('CLERK_JWT_KEY').pipe(Config.withDefault('')),
      CLERK_AUTHORIZED_PARTIES: Config.String('CLERK_AUTHORIZED_PARTIES').pipe(
        Config.withDefault(''),
      ),
      POLAR_ACCESS_TOKEN: Config.Redacted('POLAR_ACCESS_TOKEN').pipe(
        Config.withDefault(''),
      ),
      POLAR_WEBHOOK_SECRET: Config.Redacted('POLAR_WEBHOOK_SECRET').pipe(
        Config.withDefault(''),
      ),
      POLAR_PRODUCT_ID: Config.String('POLAR_PRODUCT_ID').pipe(Config.withDefault('')),
      POLAR_SERVER: Config.String('POLAR_SERVER').pipe(Config.withDefault('production')),
      APP_ORIGIN: Config.String('APP_ORIGIN'),
      APP_RELEASE_ID: Config.String('APP_RELEASE_ID').pipe(Config.withDefault('')),
      SENTRY_DSN: Config.String('SENTRY_DSN').pipe(Config.withDefault('')),
    },
  })),
)

export default Alchemy.Stack(
  'kagi',
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const site = yield* Website
    return { url: site.url }
  }),
)
