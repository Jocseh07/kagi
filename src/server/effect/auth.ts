/**
 * Who is calling.
 *
 * Networkless on purpose: `authenticateRequest` will fetch the instance JWKS
 * over the network unless `jwtKey` is supplied, which would put a round trip to
 * Clerk in front of every sync call. With the PEM in an environment variable
 * the signature is checked locally and the route costs one D1 hop, not two
 * network hops.
 *
 * `authorizedParties` is not optional in practice. Clerk's docs call out that
 * omitting it lets a token minted for any other Clerk app be replayed against
 * this one, so an unset CLERK_AUTHORIZED_PARTIES is treated as a
 * misconfiguration and fails closed rather than silently accepting everything.
 * The exception is a bearer request with no `Origin`: native clients never send
 * one, so their tokens carry no `azp` and could never pass the check.
 */

import { createClerkClient } from '@clerk/backend'
import type { ClerkClient } from '@clerk/backend'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { AppError } from '../errors'
import { Env } from './env'
import type { KagiEnv } from './env'
import { toAppError } from './errors'
import { RateLimits } from './rate-limits'

export interface AuthShape {
  /**
   * The signed-in user's id, or null when the request carries no valid
   * session. Reads the bearer token the sync client sends and the `__session`
   * cookie the browser sends to same-origin routes on its own, so the proxies
   * can tell a signed-in reader from an anonymous one. A missing Clerk config
   * is a 500: every caller that reaches this far needs Clerk to exist.
   */
  readonly authenticatedUserId: (request: Request) => Effect.Effect<string | null, AppError>
  /**
   * The signed-in user's id, or a refusal.
   *
   * Returns only the id. Callers scope every query by it, and handing back the
   * whole claims object invites reading a tenancy decision out of some other
   * claim the client can influence. The pre-auth budget is charged first: a
   * flood must not cost a Clerk verification and a D1 or Polar call per
   * request.
   */
  readonly requireUserId: (request: Request) => Effect.Effect<string, AppError>
  /** Whether Clerk is configured at all, for callers that degrade without it. */
  readonly configured: Effect.Effect<boolean>
  /** The backend client, for the few places that read Clerk beyond the token. */
  readonly clerkClient: Effect.Effect<ClerkClient, AppError>
}

function clerkClientFor(env: KagiEnv): ClerkClient {
  const secretKey = env.CLERK_SECRET_KEY
  const publishableKey = env.CLERK_PUBLISHABLE_KEY
  if (!secretKey || !publishableKey) {
    throw new AppError(500, 'Clerk is not configured on this deployment.')
  }
  return createClerkClient({ secretKey, publishableKey })
}

/** The origins allowed to mint a token. Empty is a misconfiguration. */
function authorizedParties(env: KagiEnv): Array<string> {
  const parties = (env.CLERK_AUTHORIZED_PARTIES ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (parties.length === 0) {
    throw new AppError(500, 'CLERK_AUTHORIZED_PARTIES is unset; refusing to accept tokens.')
  }
  return parties
}

async function verify(env: KagiEnv, request: Request): Promise<string | null> {
  const native = request.headers.has('authorization') && !request.headers.has('origin')
  const state = await clerkClientFor(env).authenticateRequest(request, {
    jwtKey: env.CLERK_JWT_KEY,
    authorizedParties: native ? undefined : authorizedParties(env),
  })

  if (!state.isAuthenticated) return null

  const auth = state.toAuth()

  // Clerk can authenticate a machine token (API key, M2M) as well as a user
  // session, and those carry no `userId` at all. Sync is a per-user store, so
  // anything that is not a signed-in user session is refused rather than being
  // given an empty tenancy key.
  const userId = auth && 'userId' in auth ? auth.userId : undefined
  return userId || null
}

export class Auth extends Context.Service<Auth, AuthShape>()('kagi/Auth') {
  static readonly layer = Layer.effect(
    Auth,
    Effect.gen(function* () {
      const env = yield* Env
      const rateLimits = yield* RateLimits

      const authenticatedUserId = (request: Request) =>
        Effect.tryPromise({
          try: () => verify(env, request),
          catch: (cause) => toAppError(cause, 'Clerk is not configured on this deployment.'),
        })

      const requireUserId = Effect.fn('auth.requireUserId')(function* (request: Request) {
        const key = request.headers.get('cf-connecting-ip') ?? 'unknown'
        const limited = yield* rateLimits.limit('RATE_API', key)
        if (limited) {
          return yield* Effect.fail(
            new AppError(429, 'Too many requests. Try again in a minute.'),
          )
        }

        const userId = yield* authenticatedUserId(request)
        if (!userId) return yield* Effect.fail(new AppError(401, 'Not signed in.'))

        // Whether this user has *paid* for sync is a separate question,
        // answered by server/polar.ts against D1. Tenancy is the verified user
        // id and nothing else.
        return userId
      })

      const configured = Effect.sync(() =>
        Boolean(env.CLERK_SECRET_KEY && env.CLERK_PUBLISHABLE_KEY),
      )

      const clerkClient = Effect.try({
        try: () => clerkClientFor(env),
        catch: (cause) => toAppError(cause, 'Clerk is not configured on this deployment.'),
      })

      return {
        authenticatedUserId,
        requireUserId,
        configured,
        clerkClient,
      } satisfies AuthShape
    }),
  ).pipe(Layer.provide(Layer.mergeAll(Env.layer, RateLimits.layer)))
}
