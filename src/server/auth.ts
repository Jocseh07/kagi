/**
 * Clerk session verification for the sync routes.
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
 */

import { createClerkClient } from '@clerk/backend'
import { env } from 'cloudflare:workers'

interface ClerkEnv {
  CLERK_SECRET_KEY?: string
  CLERK_PUBLISHABLE_KEY?: string
  CLERK_JWT_KEY?: string
  CLERK_AUTHORIZED_PARTIES?: string
}

/**
 * An error carrying the status the route should answer with.
 *
 * The Nitro version threw h3's `HTTPError`, which h3 turned into a response.
 * Start's server routes return plain `Response`s, so the shape a handler needs
 * is this plus the `respondTo` helper below.
 */
export class SyncError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'SyncError'
    this.status = status
  }
}

/** Turns a thrown `SyncError` into the response, and anything else into a 500. */
export function respondTo(error: unknown): Response {
  const status = error instanceof SyncError ? error.status : 500
  const message =
    error instanceof SyncError ? error.message : 'Unexpected sync failure.'
  return Response.json({ error: message }, { status })
}

/**
 * Bindings and secrets for this request.
 *
 * `cloudflare:workers` resolves these per-isolate under both `vite dev` and a
 * deployed Worker, which is what replaced the old `event.context.cloudflare.env`
 * lookup.
 */
export function cloudflareEnv<T = Record<string, unknown>>(): T {
  return env as T
}

function unauthorized(message: string): SyncError {
  return new SyncError(401, message)
}

/**
 * The signed-in user's id, or a 401.
 *
 * Returns only the id. Callers scope every query by it, and handing back the
 * whole claims object invites reading a tenancy decision out of some other
 * claim the client can influence.
 */
export async function requireUserId(request: Request): Promise<string> {
  const clerkEnv = cloudflareEnv<ClerkEnv>()

  const secretKey = clerkEnv.CLERK_SECRET_KEY
  const publishableKey = clerkEnv.CLERK_PUBLISHABLE_KEY
  if (!secretKey || !publishableKey) {
    throw new SyncError(500, 'Clerk is not configured on this deployment.')
  }

  const parties = (clerkEnv.CLERK_AUTHORIZED_PARTIES ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (parties.length === 0) {
    throw new SyncError(
      500,
      'CLERK_AUTHORIZED_PARTIES is unset; refusing to accept tokens.',
    )
  }

  const clerk = createClerkClient({ secretKey, publishableKey })

  const state = await clerk.authenticateRequest(request, {
    jwtKey: clerkEnv.CLERK_JWT_KEY,
    authorizedParties: parties,
  })

  if (!state.isAuthenticated) throw unauthorized('Not signed in.')

  const auth = state.toAuth()

  // Clerk can authenticate a machine token (API key, M2M) as well as a user
  // session, and those carry no `userId` at all. Sync is a per-user store, so
  // anything that is not a signed-in user session is refused rather than being
  // given an empty tenancy key.
  const userId = auth && 'userId' in auth ? auth.userId : undefined
  if (!userId) throw unauthorized('Session carries no user.')

  // Whether this user has *paid* for sync is a separate question, answered by
  // server/polar.ts against D1. Tenancy is the verified user id and nothing
  // else.
  return userId
}
