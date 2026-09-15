/**
 * A pre-authenticated link to Polar's customer portal, where the subscriber
 * cancels, changes card, or downloads invoices. Polar owns all of that.
 */

import { createFileRoute } from '@tanstack/react-router'

import { requireUserId, respondTo } from '@/server/auth'
import { polarClient } from '@/server/polar'

export const Route = createFileRoute('/api/billing/portal')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const userId = await requireUserId(request)
          const origin = new URL(request.url).origin
          const session = await polarClient().customerSessions.create({
            externalCustomerId: userId,
            returnUrl: `${origin}/settings`,
          })
          return Response.json({ url: session.customerPortalUrl })
        } catch (error) {
          return respondTo(error)
        }
      },
    },
  },
})
