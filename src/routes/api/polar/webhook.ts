/**
 * Polar → D1. Unauthenticated by design and signed by Polar instead.
 *
 * Only `customer.state_changed` matters: it fires for every subscription
 * change and carries the whole current state, so one event type covers
 * purchase, cancellation, lapse and refund. Every other event is acknowledged
 * and ignored so Polar does not retry it.
 *
 * Customers without an `external_id` were not created by this app's checkout
 * and have no user to map to, so they are skipped.
 */

import { createFileRoute } from '@tanstack/react-router'
import { WebhookVerificationError, validateEvent } from '@polar-sh/sdk/webhooks'

import { syncDb } from '@/server/db'
import { entitlementFromState, polarEnv, writeEntitlement } from '@/server/polar'

async function handle(request: Request): Promise<Response> {
  const secret = polarEnv().POLAR_WEBHOOK_SECRET
  if (!secret) {
    return Response.json({ error: 'POLAR_WEBHOOK_SECRET is unset.' }, { status: 500 })
  }

  const body = await request.text()
  const headers: Record<string, string> = {}
  request.headers.forEach((value, key) => {
    headers[key] = value
  })

  let event
  try {
    event = validateEvent(body, headers, secret)
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      return new Response(null, { status: 403 })
    }
    throw error
  }

  if (event.type !== 'customer.state_changed') {
    return new Response(null, { status: 202 })
  }

  const { externalId } = event.data
  if (!externalId) return new Response(null, { status: 202 })

  await writeEntitlement(syncDb(), externalId, entitlementFromState(event.data))
  return new Response(null, { status: 202 })
}

export const Route = createFileRoute('/api/polar/webhook')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          return await handle(request)
        } catch (error) {
          console.error('polar webhook failed', error)
          return Response.json({ error: 'Webhook failed.' }, { status: 500 })
        }
      },
    },
  },
})
