/**
 * Starts a Polar checkout for the Sync plan and returns its URL.
 *
 * The customer is keyed by the verified Clerk user id, never by anything in
 * the request, so the webhook that follows can only ever unlock this account.
 * The success URL returns to Settings with a flag the client uses to refresh.
 */

import { createFileRoute } from '@tanstack/react-router'
import * as Effect from 'effect/Effect'

import { Auth } from '@/server/effect/auth'
import { Billing } from '@/server/effect/billing'
import { attempt } from '@/server/effect/errors'
import { runServer } from '@/server/effect/run'
import { respondTo } from '@/server/errors'

export const Route = createFileRoute('/api/billing/checkout')({
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
              const productId = yield* billing.productId
              const origin = new URL(request.url).origin
              const checkout = yield* attempt(
                () =>
                  polar.checkouts.create({
                    products: [productId],
                    externalCustomerId: userId,
                    successUrl: `${origin}/settings?billing=done`,
                    customerIpAddress: request.headers.get('cf-connecting-ip'),
                  }),
                'Could not reach the payment provider.',
              )
              return Response.json({ url: checkout.url })
            }),
          )
        } catch (error) {
          return respondTo(error)
        }
      },
    },
  },
})
