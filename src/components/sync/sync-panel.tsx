/**
 * Settings → Sync. Where sync is explained, and the only place its state is
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
import { useAuth, useUser } from '@clerk/react'
import { CloudOff, RefreshCw, TriangleAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
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

export function SyncPanel() {
  // `undefined` until Clerk answers. Told apart from "signed out" so the panel
  // does not flash a sign-in prompt at somebody who is already signed in.
  const { isSignedIn } = useAuth()
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
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">Sync</h2>
        <span className="shrink-0 text-xs text-muted-foreground">
          {isSignedIn ? formatWhen(status.data?.lastAt ?? null) : 'Signed out'}
        </span>
      </header>

      {isSignedIn === undefined ? (
        <div className="space-y-3 px-4 py-4">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-9 w-32" />
        </div>
      ) : isSignedIn ? (
        <div className="space-y-4 px-4 py-4">
          <div className="space-y-1">
            <p className="text-3xl font-semibold tracking-tight tabular-nums sm:text-2xl">
              {pending}
            </p>
            <p className="text-base text-muted-foreground sm:text-sm">
              {pending === 1
                ? 'change waiting to send'
                : 'changes waiting to send'}
            </p>
          </div>

          <Button
            disabled={running || mismatch || !entitled || !ready}
            onClick={() => void sync()}
          >
            <RefreshCw className={running ? 'size-4 animate-spin' : 'size-4'} />
            {running ? 'Syncing…' : 'Sync now'}
          </Button>

          <p className="text-xs leading-relaxed text-muted-foreground">
            Syncs when you finish or leave a chapter, when you return to the
            app, and when you sign in. Sync now runs it right away.
          </p>

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
              Sync needs the plan above. Your library stays on this device.
            </p>
          ) : null}

          {!ready ? (
            <p className="text-xs text-muted-foreground">
              Waiting for the library database…
            </p>
          ) : null}

          {lastOutcome && !running && !mismatch ? (
            <SyncResult outcome={lastOutcome} />
          ) : null}
        </div>
      ) : (
        <p className="px-4 py-4 text-sm text-muted-foreground">Sign in above to sync.</p>
      )}
    </section>
  )
}

function SyncResult({ outcome }: { outcome: SyncOutcome }) {
  if (outcome.error) {
    return (
      <p
        role="alert"
        className="flex items-start gap-2 rounded-md border border-border p-3 text-xs text-muted-foreground"
      >
        <CloudOff className="mt-0.5 size-4 shrink-0" />
        <span>
          Sync did not finish: {outcome.error} Your library is safe on this
          device, and the next press resumes where this one stopped.
        </span>
      </p>
    )
  }

  if (outcome.pushed === 0 && outcome.pulled === 0) {
    return <p className="text-xs text-muted-foreground">Already up to date.</p>
  }

  return (
    <p className="text-xs tabular-nums text-muted-foreground">
      Sent {outcome.pushed} · received {outcome.pulled}
    </p>
  )
}
