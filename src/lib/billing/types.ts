/**
 * The billing shapes shared by the server and the client. Kept apart from
 * server/polar.ts so a client can name them without compiling the Worker code.
 */

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

/** What the Sync plan costs, as shown before checkout. */
export interface PlanSummary {
  name: string
  /** Minor units. `null` for pay-what-you-want or free prices. */
  amount: number | null
  currency: string | null
  interval: string | null
}
