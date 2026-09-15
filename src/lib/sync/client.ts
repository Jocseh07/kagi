/**
 * The sync loop: push dirty rows up, then pull peers' changes down.
 *
 * Reached through `useSync` in lib/sync/use-sync.ts: the once-per-sign-in run,
 * the buttons in the header and in Settings, and the event triggers in
 * lib/sync/sync-events.ts. Nothing here is timed; the events are rate-limited
 * before they get here.
 *
 * Push first, deliberately. Pulling first would apply a peer's older copy of a
 * row this device has just edited, and the local edit would then be pushed as
 * an "older" write and lose. Sending first means the server has this device's
 * state before it answers.
 *
 * Nothing here throws for an offline device. Sync is a background convenience;
 * a failure leaves every dirty flag and cursor untouched so the next run picks
 * up exactly where this one stopped, and the app carries on entirely from
 * local storage.
 */

import { setPendingHint } from '@/lib/db/change-signal'
import { getSetting, setSetting } from '@/lib/db/repositories'
import {
  applyPulled,
  collectPending,
  markPushed,
  pendingCount,
  reprojectDeferred,
} from './local'
import { MAX_PUSH_BATCH, parseCursor } from './protocol'
import type { PullResponse, PushResponse, SyncFact } from './protocol'
import { seedLedger } from './seed'

/** Last server sequence this device has applied. */
export const SETTING_SYNC_PULL_CURSOR = 'sync.pull_cursor'

/** When the last successful sync finished, for the status line. */
export const SETTING_SYNC_LAST_AT = 'sync.last_at'

/**
 * Which account the local database currently holds.
 *
 * Signing in as a different user on a device that already has a library must
 * not merge the two. This records who the rows belong to so that case can be
 * detected and refused rather than silently blended.
 */
export const SETTING_SYNC_USER = 'sync.user_id'

/** Passes at pulling in one run, so a huge first sync cannot loop forever. */
const MAX_PULL_PASSES = 20

/**
 * Full push+pull rounds in one run. More than one is only needed when rows
 * went dirty *while* the run was in flight — reading during a sync — or when
 * a first pull was too large for one round.
 */
const MAX_ROUNDS = 3

export interface SyncOutcome {
  pushed: number
  pulled: number
  /** Set when the run stopped early; nothing was cleared past that point. */
  error?: string
}

export type TokenSource = () => Promise<string | null>

async function authorizedFetch(
  getToken: TokenSource,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  // Fetched per request rather than once per run: Clerk session tokens last
  // about a minute, and a long first sync outlives a token captured up front.
  const token = await getToken()
  if (!token) throw new Error('Not signed in.')

  const response = await fetch(path, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })

  if (!response.ok) {
    if (response.status === 402) throw new Error('Sync needs the Sync plan.')
    throw new Error(`Sync failed: ${response.status} ${response.statusText}`)
  }

  // A 200 that is not JSON means the request never reached the sync route and
  // was answered with the SPA shell instead — a static asset rule shadowing
  // `/api/*`, or a build whose server routes did not make it into the Worker.
  // Without this check that arrives as an opaque JSON parse error.
  const type = response.headers.get('content-type') ?? ''
  if (!type.includes('application/json')) {
    throw new Error('Sync API is not reachable from this build.')
  }

  return response
}

async function push(getToken: TokenSource): Promise<number> {
  const plan = await collectPending()
  if (plan.facts.length === 0) return 0

  const batches: SyncFact[][] = []
  for (let start = 0; start < plan.facts.length; start += MAX_PUSH_BATCH) {
    batches.push(plan.facts.slice(start, start + MAX_PUSH_BATCH))
  }

  let sent = 0
  for (const batch of batches) {
    const response = await authorizedFetch(getToken, '/api/sync/push', {
      method: 'POST',
      body: JSON.stringify({ facts: batch }),
    })
    const result = (await response.json()) as PushResponse
    sent += result.applied
  }

  // Acknowledged only once every batch has landed. A run that stopped partway
  // acknowledges nothing and simply re-sends later: the server's rule is
  // idempotent, so a resend costs writes but never changes an answer.
  await markPushed(plan)

  return sent
}

async function pull(getToken: TokenSource): Promise<{ pulled: number; drained: boolean }> {
  let cursor = parseCursor(await getSetting(SETTING_SYNC_PULL_CURSOR))
  let total = 0
  let drained = false
  let created = false

  for (let pass = 0; pass < MAX_PULL_PASSES; pass += 1) {
    const response = await authorizedFetch(
      getToken,
      `/api/sync/pull?cursor=${cursor}`,
    )
    const result = (await response.json()) as PullResponse

    const applied = await applyPulled(result.facts)
    total += applied.applied
    created ||= applied.created

    cursor = parseCursor(result.cursor)
    await setSetting(SETTING_SYNC_PULL_CURSOR, String(cursor))

    if (!result.hasMore) {
      drained = true
      break
    }
  }

  // Only once everything has landed. Facts that needed a series or a category
  // that arrived in a later batch than they did are projected here, where the
  // whole picture is finally present.
  if (drained && created) await reprojectDeferred()

  return { pulled: total, drained }
}

/**
 * Refuses to sync a library that belongs to somebody else.
 *
 * Without this, signing in as a second user on a shared browser would push the
 * first user's whole library into the second user's account. The local database
 * is claimed by the first account that syncs it and stays claimed until it is
 * wiped from settings.
 */
async function claimFor(userId: string): Promise<boolean> {
  const owner = await getSetting(SETTING_SYNC_USER)
  if (!owner) {
    await setSetting(SETTING_SYNC_USER, userId)
    return true
  }
  return owner === userId
}

// ------------------------------------------------------------ run + state --

export interface SyncState {
  running: boolean
  lastOutcome: SyncOutcome | null
}

let syncState: SyncState = { running: false, lastOutcome: null }
const stateListeners = new Set<() => void>()

function publishState(next: Partial<SyncState>): void {
  syncState = { ...syncState, ...next }
  for (const listener of [...stateListeners]) listener()
}

/** Module-level store so every hook instance sees the same run. */
export function subscribeSyncState(listener: () => void): () => void {
  stateListeners.add(listener)
  return () => {
    stateListeners.delete(listener)
  }
}

export function getSyncState(): SyncState {
  return syncState
}

let running: Promise<SyncOutcome> | null = null

/**
 * One run of the loop. Concurrent calls share the run in flight rather than
 * queueing: two overlapping syncs would push the same dirty rows twice and
 * spend the write budget on rows the server already has. Rows that went dirty
 * *during* a run are caught by the extra rounds before the run settles.
 */
export function runSync(
  userId: string,
  getToken: TokenSource,
): Promise<SyncOutcome> {
  running ??= (async () => {
    publishState({ running: true })
    try {
      if (!(await claimFor(userId))) {
        return {
          pushed: 0,
          pulled: 0,
          error: 'This library is already linked to a different account.',
        }
      }

      // The library that was here before the ledger existed has to be stated
      // before any of it can be sent. Idempotent and marked once done, so this
      // is a single indexed lookup on every run after the first.
      await seedLedger()

      let pushed = 0
      let pulled = 0

      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        pushed += await push(getToken)
        const result = await pull(getToken)
        pulled += result.pulled

        // Another round only when there is demonstrably more to do: rows that
        // went dirty during this round, or a pull that hit its pass ceiling.
        if (result.drained && (await pendingCount()) === 0) break
      }

      await setSetting(SETTING_SYNC_LAST_AT, String(Date.now()))
      return { pushed, pulled }
    } catch (error) {
      return { pushed: 0, pulled: 0, error: describe(error) }
    } finally {
      running = null
      // Reconcile the panel's "waiting to send" hint with the truth.
      try {
        setPendingHint(await pendingCount())
      } catch {
        // The database went away mid-run; the stale hint only over-warns.
      }
    }
  })().then((outcome) => {
    publishState({ running: false, lastOutcome: outcome })
    return outcome
  })
  return running
}

/**
 * What to put in front of the reader when a run stops.
 *
 * drizzle wraps a failed statement in an error whose message is the SQL and
 * every bound parameter, and puts the reason on `cause`. Printed raw that is a
 * screenful of query where the useful sentence — which constraint, which
 * table — is the part that was thrown away. The innermost cause is the reason;
 * the length cap is for the same wrapper reaching the panel by another route.
 *
 * Punctuated because the panel continues the sentence after it.
 */
function describe(error: unknown): string {
  let current = error
  while (current instanceof Error && current.cause instanceof Error) {
    current = current.cause
  }
  const message = current instanceof Error ? current.message : String(current)
  const trimmed = message.trim()
  const capped = trimmed.length <= 160 ? trimmed : `${trimmed.slice(0, 159)}…`
  return /[.!?…]$/.test(capped) ? capped : `${capped}.`
}

export interface SyncStatus {
  pending: number
  lastAt: number | null
  owner: string | null
}

export async function readSyncStatus(): Promise<SyncStatus> {
  const [pending, lastAt, owner] = await Promise.all([
    pendingCount(),
    getSetting(SETTING_SYNC_LAST_AT),
    getSetting(SETTING_SYNC_USER),
  ])
  return {
    pending,
    lastAt: lastAt ? Number(lastAt) : null,
    owner,
  }
}
