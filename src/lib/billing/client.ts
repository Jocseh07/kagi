/**
 * The client side of the Sync plan: ask whether this account has it, and
 * hand off to Polar's hosted pages for buying and managing it.
 *
 * Both hand-offs are full-page navigations: Polar hosts checkout and the
 * customer portal, and each brings the reader back to Settings when done.
 */

import type { PlanSummary, SubscriptionSummary } from '@/server/polar'
import type { TokenSource } from '@/lib/sync/client'

export type { PlanSummary, SubscriptionSummary }

export interface EntitlementStatus {
  active: boolean
  /** Polar knows this account: it has subscribed at least once. */
  hasCustomer: boolean
  subscription: SubscriptionSummary | null
}

async function authorizedJson<T>(
  getToken: TokenSource,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const token = await getToken()
  if (!token) throw new Error('Not signed in.')
  const response = await fetch(path, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${token}` },
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request failed: ${response.status}`)
  }
  return (await response.json()) as T
}

export async function fetchEntitlement(
  getToken: TokenSource,
  refresh = false,
): Promise<EntitlementStatus> {
  return authorizedJson<EntitlementStatus>(
    getToken,
    refresh ? '/api/billing/status?refresh=1' : '/api/billing/status',
  )
}

export async function fetchPlan(): Promise<PlanSummary> {
  const response = await fetch('/api/billing/plan')
  if (!response.ok) throw new Error(`Request failed: ${response.status}`)
  return (await response.json()) as PlanSummary
}

const INTERVALS: Record<string, string> = {
  day: 'a day',
  week: 'a week',
  month: 'a month',
  year: 'a year',
}

/** "$10.00 a year", or "Pay what you want" when there is no fixed amount. */
export function formatPrice(
  amount: number | null,
  currency: string | null,
  interval: string | null,
): string {
  if (amount === null || !currency) return 'Pay what you want'
  const money = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amount / 100)
  const per = interval ? INTERVALS[interval] ?? `per ${interval}` : null
  return per ? `${money} ${per}` : money
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export async function openCheckout(getToken: TokenSource): Promise<void> {
  const { url } = await authorizedJson<{ url: string }>(
    getToken,
    '/api/billing/checkout',
    { method: 'POST' },
  )
  window.location.assign(url)
}

export async function openPortal(getToken: TokenSource): Promise<void> {
  const { url } = await authorizedJson<{ url: string }>(
    getToken,
    '/api/billing/portal',
    { method: 'POST' },
  )
  window.location.assign(url)
}
