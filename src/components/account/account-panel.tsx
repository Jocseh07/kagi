/**
 * The account, as shown in the profile dialog: who you are signed in as, and
 * the Sync plan. Signed out it is a sign-in offer.
 *
 * The plan card itself is shared with Settings; see plan-card.tsx.
 *
 * Only mounted when a Clerk key is configured — every hook below throws outside
 * a `ClerkProvider`. The caller does that check; see lib/sync/config.ts.
 *
 * Unwrapped: the dialog supplies the surface, so this is a titled block rather
 * than a card of its own.
 */

// `Show` renders null while the session is still loading, which is what keeps
// the panel from flashing a sign-in button at an already signed-in user.
import { Show, SignInButton, UserButton, useUser } from '@clerk/react'

import { PlanCard } from '@/components/account/plan-card'
import { Button } from '@/components/ui/button'

export function AccountPanel() {
  return (
    <section className="space-y-4">
      <Show when="signed-out">
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Optional. Signing in keeps your devices in step.
          </p>
          <SignInButton mode="modal">
            <Button>Sign in</Button>
          </SignInButton>
        </div>
      </Show>

      <Show when="signed-in">
        <SignedInBody />
      </Show>
    </section>
  )
}

function SignedInBody() {
  const { user } = useUser()

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <UserButton />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {user?.fullName ?? user?.username ?? 'Signed in'}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {user?.primaryEmailAddress?.emailAddress}
          </p>
        </div>
      </div>

      <PlanCard />
    </div>
  )
}
