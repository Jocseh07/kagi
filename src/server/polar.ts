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
 */

import { Polar } from '@polar-sh/sdk'
import { PolarError } from '@polar-sh/sdk/models/errors/polarerror.js'
import { eq } from 'drizzle-orm'

import { syncEntitlements } from '@/lib/db/sync-schema'
import { SyncError, cloudflareEnv } from './auth'
import type { SyncDb } from './db'

interface PolarEnv {
  POLAR_ACCESS_TOKEN?: string
  POLAR_WEBHOOK_SECRET?: string
  POLAR_PRODUCT_ID?: string
  POLAR_SERVER?: string
}

export function polarEnv(): PolarEnv {
  return cloudflareEnv<PolarEnv>()
}

export function polarClient(): Polar {
  const env = polarEnv()
  if (!env.POLAR_ACCESS_TOKEN) {
    throw new SyncError(500, 'Polar is not configured on this deployment.')
  }
  return new Polar({
    accessToken: env.POLAR_ACCESS_TOKEN,
    server: env.POLAR_SERVER === 'sandbox' ? 'sandbox' : 'production',
  })
}

export function polarProductId(): string {
  const id = polarEnv().POLAR_PRODUCT_ID
  if (!id) throw new SyncError(500, 'POLAR_PRODUCT_ID is unset.')
  return id
}

/** Wire and storage shape of an active subscription, for display only. */
export interface SubscriptionSummary {
  status: string
  /** Minor units, as Polar reports it. */
  amount: number
  currency: string
  interval: string
  /** ISO timestamps. */
  currentPeriodEnd: string
  cancelAtPeriodEnd: boolean
  endsAt: string | null
}

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

export async function writeEntitlement(
  db: SyncDb,
  userId: string,
  entitlement: Entitlement,
): Promise<void> {
  const row = {
    userId,
    active: entitlement.active ? 1 : 0,
    polarCustomerId: entitlement.polarCustomerId,
    subscription: entitlement.subscription
      ? JSON.stringify(entitlement.subscription)
      : null,
    updatedAt: Date.now(),
  }
  await db
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
    })
}

/** The cached answer, or `null` when Polar has never been asked. */
export async function readEntitlement(
  db: SyncDb,
  userId: string,
): Promise<Entitlement | null> {
  const [row] = await db
    .select({
      active: syncEntitlements.active,
      polarCustomerId: syncEntitlements.polarCustomerId,
      subscription: syncEntitlements.subscription,
    })
    .from(syncEntitlements)
    .where(eq(syncEntitlements.userId, userId))
    .limit(1)
  if (!row) return null
  return {
    active: row.active === 1,
    polarCustomerId: row.polarCustomerId,
    subscription: parseSubscription(row.subscription),
  }
}

/**
 * Asks Polar and stores the answer.
 *
 * A customer Polar has never heard of is simply not subscribed: checkout
 * creates the customer, so before the first purchase the lookup is a 404.
 */
export async function refreshEntitlement(
  db: SyncDb,
  userId: string,
): Promise<Entitlement> {
  let entitlement: Entitlement
  try {
    const state = await polarClient().customers.getStateExternal({
      externalId: userId,
    })
    entitlement = entitlementFromState(state)
  } catch (error) {
    if (error instanceof PolarError && error.statusCode === 404) {
      entitlement = { active: false, polarCustomerId: null, subscription: null }
    } else {
      throw new SyncError(502, 'Could not reach the payment provider.')
    }
  }
  await writeEntitlement(db, userId, entitlement)
  return entitlement
}

/** The cache when it has an answer, Polar when it does not. */
export async function resolveEntitlement(
  db: SyncDb,
  userId: string,
): Promise<Entitlement> {
  return (await readEntitlement(db, userId)) ?? refreshEntitlement(db, userId)
}

/**
 * The enforcement point for the sync routes. 402 rather than 403 so the client
 * can tell "not subscribed" apart from "not allowed".
 */
export async function requireSyncEntitled(
  db: SyncDb,
  userId: string,
): Promise<void> {
  const entitlement = await resolveEntitlement(db, userId)
  if (!entitlement.active) {
    throw new SyncError(402, 'Sync needs the Sync plan.')
  }
}

/** What the Sync plan costs, as shown before checkout. */
export interface PlanSummary {
  name: string
  /** Minor units. `null` for pay-what-you-want or free prices. */
  amount: number | null
  currency: string | null
  interval: string | null
}

let planCache: { at: number; plan: PlanSummary } | null = null
const PLAN_TTL_MS = 10 * 60 * 1000

/**
 * The product's name and price, cached per isolate. It changes when you edit
 * the product in Polar and almost never otherwise, so ten minutes is plenty.
 */
export async function fetchPlan(): Promise<PlanSummary> {
  if (planCache && Date.now() - planCache.at < PLAN_TTL_MS) return planCache.plan

  const product = await polarClient().products.get({ id: polarProductId() })
  const price = product.prices.find(
    (p) => !p.isArchived && p.amountType === 'fixed',
  )
  const plan: PlanSummary = {
    name: product.name,
    amount: price && price.amountType === 'fixed' ? price.priceAmount : null,
    currency: price && price.amountType === 'fixed' ? price.priceCurrency : null,
    interval: product.recurringInterval,
  }
  planCache = { at: Date.now(), plan }
  return plan
}
