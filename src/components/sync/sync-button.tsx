/**
 * Sync from anywhere: the header's one-tap run.
 *
 * The Sync panel in Settings still owns the explanation — the count in words,
 * the last run, the account mismatch, what a failure means. This owns none of
 * that. It is the action, plus the smallest possible statement of state: it
 * turns while running, and carries a dot while something is waiting to go up.
 * The rest is in the tooltip, where it costs no room on the bar.
 *
 * Signed out there is nothing to press and nothing to explain here, so the
 * button is not rendered at all; Settings → Sync carries the sign-in prompt.
 *
 * Only mounted when a Clerk key is configured; every hook below throws outside
 * a `ClerkProvider`. The caller does that check — see lib/sync/config.ts.
 */

import { useSyncExternalStore } from 'react'
import { useAuth } from '@clerk/react'
import { RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { getPendingHint, subscribeChanges } from '@/lib/db/change-signal'
import { useDatabaseReady } from '@/lib/db/provider'
import { useSync, useSyncEntitled } from '@/lib/sync/use-sync'
import { cn } from '@/lib/utils'

export function SyncButton() {
  const { isSignedIn } = useAuth()
  const { running, lastOutcome, sync } = useSync()
  const entitled = useSyncEntitled()
  const ready = useDatabaseReady()

  const pending = useSyncExternalStore(
    subscribeChanges,
    getPendingHint,
    getPendingHint,
  )

  // `undefined` while Clerk decides, which reads as signed out: a button that
  // appears a beat after the bar has settled is worse than one that was never
  // there.
  if (isSignedIn !== true) return null

  const failed = Boolean(lastOutcome?.error) && !running
  const label = running
    ? 'Syncing…'
    : failed
      ? 'Sync did not finish. Try again'
      : pending > 0
        ? `Sync now: ${pending} waiting to send`
        : 'Sync now'

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      disabled={running || !entitled || !ready}
      className={cn(
        'relative shrink-0',
        failed
          ? 'text-destructive hover:text-destructive'
          : 'text-muted-foreground hover:text-foreground',
      )}
      onClick={() => void sync()}
    >
      <RefreshCw className={running ? 'animate-spin' : undefined} />

      {/* Ringed in the header's own surface so the dot reads as a badge on the
          icon rather than a stray mark next to it. */}
      {pending > 0 && !running ? (
        <span
          aria-hidden
          className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary ring-2 ring-card"
        />
      ) : null}
    </Button>
  )
}
