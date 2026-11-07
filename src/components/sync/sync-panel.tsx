/**
 * The body of Settings → Account's Sync group. The only place sync state is
 * reported in full: the count in words, the last run, an account mismatch, what
 * a failure means. The header button is the same action without any of that.
 *
 * A run happens on sign-in, on the reading events, and when a button is
 * pressed, never on a timer. One run is whole — everything waiting goes up, everything the other devices did
 * comes down. That fact has exactly one home, and this is it.
 *
 * Only mounted when a Clerk key is configured; every hook below throws outside
 * a `ClerkProvider`. The caller does that check — see lib/sync/config.ts.
 */

import { useEffect, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useUser } from '@clerk/react'
import { CloudOff, RefreshCw, TriangleAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useEntitlement } from '@/lib/billing/use-entitlement'
import {
  getPendingHint,
  setPendingHint,
  subscribeChanges,
} from '@/lib/db/change-signal'
import { useDatabaseReady } from '@/lib/db/provider'
import { readSyncStatus } from '@/lib/sync/client'
import type { SyncOutcome } from '@/lib/sync/client'
import { useSync, useSyncEntitled } from '@/lib/sync/use-sync'

function formatWhen(at: number | null): string {
  if (!at) return 'Never synced'
  const seconds = Math.round((Date.now() - at) / 1000)
  if (seconds < 60) return 'Synced just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `Synced ${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `Synced ${hours} hour${hours === 1 ? '' : 's'} ago`
  return `Synced ${new Date(at).toLocaleDateString()}`
}

/** Rendered by the Account panel once Clerk reports a signed-in session. */
export function SyncStatus() {
  const { user } = useUser()
  const { running, lastOutcome, sync } = useSync()
  const entitled = useSyncEntitled()
  const plan = useEntitlement()
  const ready = useDatabaseReady()

  const status = useQuery({
    queryKey: ['sync', 'status', running, lastOutcome],
    queryFn: readSyncStatus,
    enabled: ready,
  })

  // The counted truth seeds the hint; the hint then moves on every decision
  // recorded, without counting the ledger on each render.
  useEffect(() => {
    if (status.data) setPendingHint(status.data.pending)
  }, [status.data])

  const pending = useSyncExternalStore(
    subscribeChanges,
    getPendingHint,
    getPendingHint,
  )

  const mismatch = Boolean(
    status.data?.owner && user?.id && status.data.owner !== user.id,
  )

  return (
    <div className="space-y-4 px-4 py-4">
      <div className="flex flex-col gap-4 @md:flex-row @md:items-end @md:justify-between">
        <div className="min-w-0 space-y-1">
          <p className="text-3xl font-semibold tracking-tight tabular-nums md:text-2xl">
            {pending}
          </p>
          <p className="text-sm text-muted-foreground">
            {pending === 1 ? 'change waiting to send' : 'changes waiting to send'}
          </p>
        </div>

        <Button
          className="h-10 w-full md:h-9 @md:w-auto"
          disabled={running || mismatch || !entitled || !ready}
          onClick={() => void sync()}
        >
          <RefreshCw className={running ? 'animate-spin motion-reduce:animate-none' : undefined} />
          {running ? 'Syncing…' : 'Sync now'}
        </Button>
      </div>

      {lastOutcome?.error && !running && !mismatch ? (
        <SyncFailure error={lastOutcome.error} />
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {formatWhen(status.data?.lastAt ?? null)}.{' '}
          {lastOutcome && !running && !mismatch ? <SyncResult outcome={lastOutcome} /> : null}
          Runs on its own when you finish or leave a chapter, come back to the
          app, or sign in.
        </p>
      )}

      {mismatch ? (
        <p className="flex items-start gap-2 rounded-md border border-destructive/40 p-3 text-xs text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span>
            This library is already linked to a different account. Sign in as
            that account, or erase the library from the Data tab before
            syncing this one.
          </span>
        </p>
      ) : null}

      {plan.active === false && !mismatch ? (
        <p className="text-xs text-muted-foreground">
          Sync needs the plan below. Your library stays on this device.
        </p>
      ) : null}

      {!ready ? (
        <p className="text-xs text-muted-foreground">
          Loading…
        </p>
      ) : null}
    </div>
  )
}

function SyncFailure({ error }: { error: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-md border border-destructive/40 p-3 text-xs text-muted-foreground"
    >
      <CloudOff className="mt-0.5 size-4 shrink-0 text-destructive" />
      <span>
        <span className="font-medium text-foreground">Sync did not finish.</span>{' '}
        {error} Your library is safe on this device, and the next sync picks up
        where this one stopped.
      </span>
    </p>
  )
}

/** The last successful run, as the middle sentence of the status line. */
function SyncResult({ outcome }: { outcome: SyncOutcome }) {
  if (outcome.pushed === 0 && outcome.pulled === 0) {
    return <>Already up to date. </>
  }

  return (
    <span className="tabular-nums">
      Last sync sent {outcome.pushed} and received {outcome.pulled}.{' '}
    </span>
  )
}
