/**
 * The Sync plan, in one card: what it costs and buys before subscribing, and
 * what is being paid and when it renews after. Rendered by the profile dialog
 * and by Settings, so the plan has one shape wherever it appears.
 *
 * Checkout and management are Polar-hosted pages that return to Settings.
 *
 * Only mounted when a Clerk key is configured; every hook below throws outside
 * a `ClerkProvider`. The caller does that check; see lib/sync/config.ts.
 */

import { Check } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDate, formatPrice } from '@/lib/billing/client'
import type { PlanSummary, SubscriptionSummary } from '@/lib/billing/client'
import {
  ALWAYS_FREE,
  PLAN_INCLUDES,
  useCheckout,
  useEntitlement,
  usePlan,
  usePortal,
} from '@/lib/billing/use-entitlement'

export function PlanCard() {
  const { status, loading, error } = useEntitlement()
  const plan = usePlan()

  if (loading || status === undefined) {
    return (
      <div className="space-y-2 rounded-md border border-border p-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-48" />
        <Skeleton className="h-8 w-24" />
      </div>
    )
  }

  if (error) {
    return (
      <p role="alert" className="rounded-md border border-border p-3 text-xs text-muted-foreground">
        Could not check your plan. {error}
      </p>
    )
  }

  if (status.active && status.subscription) {
    return <SubscribedCard subscription={status.subscription} name={plan.data?.name} />
  }

  return (
    <OfferCard
      plan={plan.data}
      planError={plan.error?.message ?? null}
      lapsed={status.hasCustomer}
    />
  )
}

function OfferCard({
  plan,
  planError,
  lapsed,
}: {
  plan: PlanSummary | undefined
  planError: string | null
  lapsed: boolean
}) {
  const checkout = useCheckout()
  const portal = usePortal()

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">{plan?.name ?? 'Sync'}</p>
          {plan ? (
            <p className="text-sm tabular-nums text-muted-foreground">
              {formatPrice(plan.amount, plan.currency, plan.interval)}
            </p>
          ) : planError ? (
            <p className="text-xs text-muted-foreground">Price unavailable</p>
          ) : (
            <Skeleton className="h-4 w-24" />
          )}
        </div>
        <Badge variant="outline">{lapsed ? 'Lapsed' : 'Not subscribed'}</Badge>
      </div>

      <PlanFacts />

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => checkout.mutate()}
          disabled={checkout.isPending || checkout.isSuccess}
        >
          {checkout.isPending || checkout.isSuccess ? 'Opening checkout…' : 'Subscribe'}
        </Button>
        {lapsed ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => portal.mutate()}
            disabled={portal.isPending || portal.isSuccess}
          >
            {portal.isPending || portal.isSuccess ? 'Opening…' : 'Past subscriptions'}
          </Button>
        ) : null}
      </div>

      {checkout.error ? (
        <p role="alert" className="text-xs text-muted-foreground">
          Could not open checkout. {checkout.error.message}
        </p>
      ) : null}
      {portal.error ? (
        <p role="alert" className="text-xs text-muted-foreground">
          Could not open the subscription page. {portal.error.message}
        </p>
      ) : null}
    </div>
  )
}

function SubscribedCard({
  subscription,
  name,
}: {
  subscription: SubscriptionSummary
  name: string | undefined
}) {
  const portal = usePortal()
  const ending = subscription.cancelAtPeriodEnd || subscription.endsAt !== null
  const trial = subscription.status === 'trialing'
  const when = formatDate(subscription.endsAt ?? subscription.currentPeriodEnd)

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">{name ?? 'Sync'}</p>
          <p className="text-sm tabular-nums text-muted-foreground">
            {formatPrice(subscription.amount, subscription.currency, subscription.interval)}
          </p>
        </div>
        <Badge variant={ending ? 'outline' : 'secondary'}>
          {trial ? 'Trial' : ending ? 'Ending' : 'Active'}
        </Badge>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="font-medium">{trial ? 'Trial ends' : ending ? 'Ends' : 'Renews'}</dt>
        <dd className="tabular-nums text-muted-foreground">{when}</dd>
      </dl>

      <PlanFacts />

      <Button
        variant="outline"
        size="sm"
        onClick={() => portal.mutate()}
        disabled={portal.isPending || portal.isSuccess}
      >
        {portal.isPending || portal.isSuccess ? 'Opening…' : 'Manage subscription'}
      </Button>
      {portal.error ? (
        <p role="alert" className="text-xs text-muted-foreground">
          Could not open the subscription page. {portal.error.message}
        </p>
      ) : null}
    </div>
  )
}

/** What the plan includes, and what stays free. One home for both lists. */
export function PlanFacts() {
  return (
    <div className="space-y-2 text-xs">
      <ul className="space-y-1">
        {PLAN_INCLUDES.map((item) => (
          <li key={item} className="flex items-start gap-2">
            <Check className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
            <span>{item}</span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">
        Always free: {ALWAYS_FREE.join('. ')}.
      </p>
    </div>
  )
}
