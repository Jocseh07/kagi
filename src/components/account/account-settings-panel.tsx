/**
 * Settings → Account: who is signed in and the Sync plan, above the Sync
 * panel. The plan card is the same one the profile dialog shows.
 *
 * This is also where checkout returns (`?billing=done`): the webhook may not
 * have landed yet, so Polar is asked directly once, then the flag is dropped
 * so a reload does not ask again.
 *
 * Only mounted when a Clerk key is configured; every hook below throws outside
 * a `ClerkProvider`. The caller does that check; see lib/sync/config.ts.
 */

import { useEffect } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { SignInButton, useAuth, useUser } from '@clerk/react'
import { UserRound } from 'lucide-react'

import { PlanCard } from '@/components/account/plan-card'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useEntitlement } from '@/lib/billing/use-entitlement'
import { initialsOf } from '@/lib/profile/store'

export function AccountSettingsPanel() {
  const { isSignedIn } = useAuth()
  const { user } = useUser()
  const plan = useEntitlement()

  const billing = useSearch({ from: '/settings/', select: (s) => s.billing })
  const navigate = useNavigate()
  useEffect(() => {
    if (billing !== 'done' || isSignedIn !== true) return
    void plan.refresh().finally(() => {
      void navigate({
        to: '/settings',
        // Pin the tab: without `billing` the route's fallback would leave Account.
        search: (prev) => ({ ...prev, tab: 'account', billing: undefined }),
        replace: true,
      })
    })
    // `plan.refresh` is stable per user; identity changes re-run via `isSignedIn`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billing, isSignedIn])

  const name = user?.fullName ?? user?.username ?? 'Signed in'

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">Account</h2>
        {isSignedIn === false ? (
          <span className="text-xs text-muted-foreground">Signed out</span>
        ) : null}
      </header>

      {isSignedIn === undefined ? (
        <div className="space-y-3 px-4 py-4">
          <div className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-full" />
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-44" />
            </div>
          </div>
          <Skeleton className="h-24 w-full rounded-md" />
        </div>
      ) : isSignedIn ? (
        <div className="space-y-4 px-4 py-4">
          <div className="flex items-center gap-3">
            <Avatar size="lg">
              {user?.imageUrl ? <AvatarImage src={user.imageUrl} alt="" /> : null}
              <AvatarFallback className="font-medium">{initialsOf(name)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {user?.primaryEmailAddress?.emailAddress}
              </p>
            </div>
          </div>

          <PlanCard />
        </div>
      ) : (
        <div className="px-4 py-4">
          <EmptyState
            icon={UserRound}
            title="Not signed in"
            description="Sign in to subscribe and sync across devices."
            action={
              <SignInButton mode="modal">
                <Button>Sign in</Button>
              </SignInButton>
            }
          />
        </div>
      )}
    </section>
  )
}
