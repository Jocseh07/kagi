/**
 * A pre-authenticated link to Polar's customer portal, where the subscriber
 * cancels, changes card, or downloads invoices. Polar owns all of that.
 */

import { createFileRoute } from '@tanstack/react-router'
import * as Effect from 'effect/Effect'

import { Auth } from '@/server/effect/auth'
import { Billing } from '@/server/effect/billing'
import { attempt } from '@/server/effect/errors'
import { runServer } from '@/server/effect/run'
import { respondTo } from '@/server/errors'

export const Route = createFileRoute('/api/billing/portal')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          return await runServer(
            Effect.gen(function* () {
              const auth = yield* Auth
              const billing = yield* Billing
              const userId = yield* auth.requireUserId(request)
              const polar = yield* billing.client
              const origin = new URL(request.url).origin
              const session = yield* attempt(
                () =>
                  polar.customerSessions.create({
                    externalCustomerId: userId,
                    returnUrl: `${origin}/settings`,
                  }),
                'Could not reach the payment provider.',
              )
              return Response.json({ url: session.customerPortalUrl })
            }),
          )
        } catch (error) {
          return respondTo(error)
        }
      },
    },
  },
})
