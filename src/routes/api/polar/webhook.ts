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
import * as Effect from 'effect/Effect'

import { Billing } from '@/server/effect/billing'
import { attempt } from '@/server/effect/errors'
import { runServer } from '@/server/effect/run'
import { AppError } from '@/server/errors'
import { entitlementFromState, writeEntitlement } from '@/server/polar'

const handle = Effect.fn('polar.webhook')(function* (request: Request) {
  const billing = yield* Billing
  const secret = yield* billing.webhookSecret

  const body = yield* attempt(() => request.text())
  const headers: Record<string, string> = {}
  request.headers.forEach((value, key) => {
    headers[key] = value
  })

  const event = yield* Effect.try({
    try: () => validateEvent(body, headers, secret),
    catch: (cause) =>
      cause instanceof WebhookVerificationError
        ? new AppError(403, 'Bad signature.')
        : new AppError(500, 'Webhook failed.'),
  })

  if (event.type !== 'customer.state_changed') return new Response(null, { status: 202 })

  const { externalId } = event.data
  if (!externalId) return new Response(null, { status: 202 })

  yield* writeEntitlement(externalId, entitlementFromState(event.data))
  return new Response(null, { status: 202 })
})

export const Route = createFileRoute('/api/polar/webhook')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          return await runServer(handle(request))
        } catch (error) {
          // A rejected signature is answered with a bare 403, as Polar's own
          // verification contract expects. Every other refusal keeps its own
          // message so the dashboard's delivery log says what went wrong.
          if (error instanceof AppError) {
            if (error.status === 403) return new Response(null, { status: 403 })
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('polar webhook failed', error)
          return Response.json({ error: 'Webhook failed.' }, { status: 500 })
        }
      },
    },
  },
})
