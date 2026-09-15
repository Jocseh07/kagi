/**
 * Starts a Polar checkout for the Sync plan and returns its URL.
 *
 * The customer is keyed by the verified Clerk user id, never by anything in
 * the request, so the webhook that follows can only ever unlock this account.
 * The success URL returns to Settings with a flag the client uses to refresh.
 */

import { createFileRoute } from '@tanstack/react-router'

import { requireUserId, respondTo } from '@/server/auth'
import { polarClient, polarProductId } from '@/server/polar'

export const Route = createFileRoute('/api/billing/checkout')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const userId = await requireUserId(request)
          const origin = new URL(request.url).origin
          const checkout = await polarClient().checkouts.create({
            products: [polarProductId()],
            externalCustomerId: userId,
            successUrl: `${origin}/settings?billing=done`,
            customerIpAddress: request.headers.get('cf-connecting-ip'),
          })
          return Response.json({ url: checkout.url })
        } catch (error) {
          return respondTo(error)
        }
      },
    },
  },
})
