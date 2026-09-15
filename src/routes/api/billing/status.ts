/**
 * Whether the signed-in user has the Sync plan.
 *
 * Reads the cache; `?refresh=1` asks Polar first. The client sends that on
 * the way back from checkout, where the webhook may not have landed yet.
 */

import { createFileRoute } from '@tanstack/react-router'

import { requireUserId, respondTo } from '@/server/auth'
import { syncDb } from '@/server/db'
import { refreshEntitlement, resolveEntitlement } from '@/server/polar'

export const Route = createFileRoute('/api/billing/status')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const userId = await requireUserId(request)
          const db = syncDb()
          const refresh = new URL(request.url).searchParams.get('refresh') === '1'
          const entitlement = refresh
            ? await refreshEntitlement(db, userId)
            : await resolveEntitlement(db, userId)
          return Response.json({
            active: entitlement.active,
            hasCustomer: entitlement.polarCustomerId !== null,
            subscription: entitlement.subscription,
          })
        } catch (error) {
          return respondTo(error)
        }
      },
    },
  },
})
