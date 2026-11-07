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

import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
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
import { describeError } from '@/lib/ui/describe-error'

/** `className` lets a caller that already draws the card drop this border. */
export function PlanCard({ className }: { className?: string }) {
  const { status, loading, error } = useEntitlement()
  const plan = usePlan()

  if (loading || status === undefined) {
    return (
      <div className={cn('space-y-2 rounded-md border border-border p-3', className)}>
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-48" />
        <Skeleton className="h-8 w-24" />
      </div>
    )
  }

  if (error) {
    return (
      <p
        role="alert"
        className={cn('rounded-md border border-border p-3 text-xs text-muted-foreground', className)}
      >
        Could not check your plan. {error}
      </p>
    )
  }

  if (status.active && status.subscription) {
    return (
      <SubscribedCard
        subscription={status.subscription}
        name={plan.data?.name}
        className={className}
      />
    )
  }

  return (
    <OfferCard
      plan={plan.data}
      planError={plan.error?.message ?? null}
      lapsed={status.hasCustomer}
      className={className}
    />
  )
}

function OfferCard({
  plan,
  planError,
  lapsed,
  className,
}: {
  plan: PlanSummary | undefined
  planError: string | null
  lapsed: boolean
  className?: string
}) {
  const checkout = useCheckout()
  const portal = usePortal()

  return (
    <div className={cn('space-y-3 rounded-md border border-border p-3', className)}>
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
          Could not open checkout. {describeError(checkout.error)}
        </p>
      ) : null}
      {portal.error ? (
        <p role="alert" className="text-xs text-muted-foreground">
          Could not open the subscription page. {describeError(portal.error)}
        </p>
      ) : null}
    </div>
  )
}

/**
 * A row: what is paid and when it renews, with the way to change it beside.
 * The plan's facts are already known to a subscriber, so they fold away.
 */
function SubscribedCard({
  subscription,
  name,
  className,
}: {
  subscription: SubscriptionSummary
  name: string | undefined
  className?: string
}) {
  const portal = usePortal()
  const [open, setOpen] = useState(false)
  const ending = subscription.cancelAtPeriodEnd || subscription.endsAt !== null
  const trial = subscription.status === 'trialing'
  const when = formatDate(subscription.endsAt ?? subscription.currentPeriodEnd)

  return (
    <div className={cn('space-y-3 rounded-md border border-border p-3', className)}>
      <div className="flex flex-col gap-3 @md:flex-row @md:items-center @md:gap-4">
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="flex items-center gap-2 text-sm font-medium">
            {name ?? 'Sync'}
            <Badge variant={ending ? 'outline' : 'secondary'}>
              {trial ? 'Trial' : ending ? 'Ending' : 'Active'}
            </Badge>
          </p>
          <p className="text-xs tabular-nums text-muted-foreground">
            {formatPrice(subscription.amount, subscription.currency, subscription.interval)}
            {' · '}
            {trial ? 'trial ends' : ending ? 'ends' : 'renews'} {when}
          </p>
        </div>

        <Button
          variant="outline"
          className="h-10 md:h-9"
          onClick={() => portal.mutate()}
          disabled={portal.isPending || portal.isSuccess}
        >
          {portal.isPending || portal.isSuccess ? 'Opening…' : 'Manage subscription'}
        </Button>
      </div>

      {portal.error ? (
        <p role="alert" className="text-xs text-muted-foreground">
          Could not open the subscription page. {describeError(portal.error)}
        </p>
      ) : null}

      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex h-10 w-full items-center justify-between gap-3 text-xs text-muted-foreground hover:text-foreground md:h-8">
          What the plan includes
          <ChevronDown
            className={cn(
              'size-4 transition-transform duration-150 motion-reduce:transition-none',
              open && 'rotate-180',
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-1">
          <PlanFacts />
        </CollapsibleContent>
      </Collapsible>
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
