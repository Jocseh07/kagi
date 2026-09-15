/**
 * The Sync plan's name and price. Public: the checkout page shows the same
 * thing, and the point is to show it *before* sending anyone there.
 */

import { createFileRoute } from '@tanstack/react-router'

import { respondTo } from '@/server/auth'
import { fetchPlan } from '@/server/polar'

export const Route = createFileRoute('/api/billing/plan')({
  server: {
    handlers: {
      GET: async () => {
        try {
          return Response.json(await fetchPlan(), {
            headers: { 'Cache-Control': 'public, max-age=600' },
          })
        } catch (error) {
          return respondTo(error)
        }
      },
    },
  },
})
