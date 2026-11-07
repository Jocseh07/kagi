/**
 * The Sync plan's name and price. Public: the checkout page shows the same
 * thing, and the point is to show it *before* sending anyone there.
 */

import { createFileRoute } from '@tanstack/react-router'
import * as Effect from 'effect/Effect'

import { runServer } from '@/server/effect/run'
import { respondTo } from '@/server/errors'
import { fetchPlan } from '@/server/polar'

export const Route = createFileRoute('/api/billing/plan')({
  server: {
    handlers: {
      GET: async () => {
        try {
          return await runServer(
            Effect.map(fetchPlan(), (plan) =>
              Response.json(plan, {
                headers: { 'Cache-Control': 'public, max-age=600' },
              }),
            ),
          )
        } catch (error) {
          return respondTo(error)
        }
      },
    },
  },
})
