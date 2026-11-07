/**
 * The paid half of sync: who has an active Polar subscription.
 *
 * Polar is the source of truth and D1 is the cache. The webhook keeps the
 * cache current, and `refreshEntitlement` asks Polar directly when there is no
 * row yet or the client says it just came back from checkout. The sync routes
 * only ever read the cache, so a Polar outage never blocks a subscriber.
 *
 * Tenancy is the Clerk user id on both sides: it is handed to Polar as the
 * customer's `external_id` at checkout, and read back from the same field on
 * every webhook. Nothing in a request body decides which row is written.
 *
 * The client and its wiring are the `Billing` service; what is left here is
 * the cache and the reduction of Polar's shapes to what the app stores.
 */

import { PolarError } from '@polar-sh/sdk/models/errors/polarerror.js'
import * as Effect from 'effect/Effect'
import { eq } from 'drizzle-orm'

import type { PlanSummary, SubscriptionSummary } from '@/lib/billing/types'
import { syncEntitlements } from '@/lib/db/sync-schema'
import { Billing } from './effect/billing'
import { Database } from './effect/database'
import { toAppError } from './effect/errors'
import { AppError } from './errors'

export type { PlanSummary, SubscriptionSummary }

export interface Entitlement {
  active: boolean
  polarCustomerId: string | null
  subscription: SubscriptionSummary | null
}

type CustomerStateLike = {
  id: string
  activeSubscriptions: Array<{
    status: string
    amount: number
    currency: string
    recurringInterval: string
    currentPeriodEnd: Date
    cancelAtPeriodEnd: boolean
    endsAt: Date | null
  }>
}

/** Reduces Polar's customer state to what the app stores and shows. */
export function entitlementFromState(state: CustomerStateLike): Entitlement {
  const sub = state.activeSubscriptions[0]
  return {
    active: state.activeSubscriptions.length > 0,
    polarCustomerId: state.id,
    subscription: sub
      ? {
          status: sub.status,
          amount: sub.amount,
          currency: sub.currency,
          interval: sub.recurringInterval,
          currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          endsAt: sub.endsAt ? sub.endsAt.toISOString() : null,
        }
      : null,
  }
}

function parseSubscription(raw: string | null): SubscriptionSummary | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as SubscriptionSummary
  } catch {
    return null
  }
}

export const writeEntitlement = Effect.fn('polar.writeEntitlement')(function* (
  userId: string,
  entitlement: Entitlement,
) {
  const db = yield* Database
  const row = {
    userId,
    active: entitlement.active ? 1 : 0,
    polarCustomerId: entitlement.polarCustomerId,
    subscription: entitlement.subscription
      ? JSON.stringify(entitlement.subscription)
      : null,
    updatedAt: Date.now(),
  }
  yield* db.query((c) =>
    c
      .insert(syncEntitlements)
      .values(row)
      .onConflictDoUpdate({
        target: syncEntitlements.userId,
        set: {
          active: row.active,
          polarCustomerId: row.polarCustomerId,
          subscription: row.subscription,
          updatedAt: row.updatedAt,
        },
      }),
  )
})

/** The cached answer, or `null` when Polar has never been asked. */
export const readEntitlement = Effect.fn('polar.readEntitlement')(function* (
  userId: string,
) {
  const db = yield* Database
  const [row] = yield* db.query((c) =>
    c
      .select({
        active: syncEntitlements.active,
        polarCustomerId: syncEntitlements.polarCustomerId,
        subscription: syncEntitlements.subscription,
      })
      .from(syncEntitlements)
      .where(eq(syncEntitlements.userId, userId))
      .limit(1),
  )
  if (!row) return null
  return {
    active: row.active === 1,
    polarCustomerId: row.polarCustomerId,
    subscription: parseSubscription(row.subscription),
  } satisfies Entitlement
})

/**
 * Asks Polar and stores the answer.
 *
 * A customer Polar has never heard of is simply not subscribed: checkout
 * creates the customer, so before the first purchase the lookup is a 404.
 */
export const refreshEntitlement = Effect.fn('polar.refreshEntitlement')(function* (
  userId: string,
) {
  const billing = yield* Billing
  const polar = yield* billing.client

  const entitlement = yield* Effect.tryPromise({
    try: async (): Promise<Entitlement> => {
      try {
        const state = await polar.customers.getStateExternal({ externalId: userId })
        return entitlementFromState(state)
      } catch (cause) {
        if (cause instanceof PolarError && cause.statusCode === 404) {
          return { active: false, polarCustomerId: null, subscription: null }
        }
        throw new AppError(502, 'Could not reach the payment provider.')
      }
    },
    catch: (cause) => toAppError(cause, 'Could not reach the payment provider.'),
  })

  yield* writeEntitlement(userId, entitlement)
  return entitlement
})

/** The cache when it has an answer, Polar when it does not. */
export const resolveEntitlement = Effect.fn('polar.resolveEntitlement')(function* (
  userId: string,
) {
  return (yield* readEntitlement(userId)) ?? (yield* refreshEntitlement(userId))
})

/**
 * The enforcement point for the sync routes. 402 rather than 403 so the client
 * can tell "not subscribed" apart from "not allowed".
 */
export const requireSyncEntitled = Effect.fn('polar.requireSyncEntitled')(function* (
  userId: string,
) {
  const entitlement = yield* resolveEntitlement(userId)
  if (!entitlement.active) {
    return yield* Effect.fail(new AppError(402, 'Sync needs the Sync plan.'))
  }
})

let planCache: { at: number; plan: PlanSummary } | null = null
const PLAN_TTL_MS = 10 * 60 * 1000

/**
 * The product's name and price, cached per isolate. It changes when you edit
 * the product in Polar and almost never otherwise, so ten minutes is plenty.
 */
export const fetchPlan = Effect.fn('polar.fetchPlan')(function* () {
  if (planCache && Date.now() - planCache.at < PLAN_TTL_MS) return planCache.plan

  const billing = yield* Billing
  const polar = yield* billing.client
  const id = yield* billing.productId

  const product = yield* Effect.tryPromise({
    try: () => polar.products.get({ id }),
    catch: () => new AppError(502, 'Could not reach the payment provider.'),
  })

  const price = product.prices.find((p) => !p.isArchived && p.amountType === 'fixed')
  const plan: PlanSummary = {
    name: product.name,
    amount: price && price.amountType === 'fixed' ? price.priceAmount : null,
    currency: price && price.amountType === 'fixed' ? price.priceCurrency : null,
    interval: product.recurringInterval,
  }
  planCache = { at: Date.now(), plan }
  return plan
})
