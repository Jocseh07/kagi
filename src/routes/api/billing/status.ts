/**
 * Whether the signed-in user has the Sync plan.
 *
 * Reads the cache; `?refresh=1` asks Polar first. The client sends that on
 * the way back from checkout, where the webhook may not have landed yet.
 */

import { createFileRoute } from '@tanstack/react-router'
import * as Effect from 'effect/Effect'

import { Auth } from '@/server/effect/auth'
import { runServer } from '@/server/effect/run'
import { respondTo } from '@/server/errors'
import { refreshEntitlement, resolveEntitlement } from '@/server/polar'

export const Route = createFileRoute('/api/billing/status')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          return await runServer(
            Effect.gen(function* () {
              const auth = yield* Auth
              const userId = yield* auth.requireUserId(request)
              const refresh = new URL(request.url).searchParams.get('refresh') === '1'
              const entitlement = refresh
                ? yield* refreshEntitlement(userId)
                : yield* resolveEntitlement(userId)
              return Response.json({
                active: entitlement.active,
                hasCustomer: entitlement.polarCustomerId !== null,
                subscription: entitlement.subscription,
              })
            }),
          )
        } catch (error) {
          return respondTo(error)
        }
      },
    },
  },
})
