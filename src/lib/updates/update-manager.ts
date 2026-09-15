/**
 * Runtime for Mihon's "library update": every favourite is asked for its
 * chapter list and anything not already stored is written.
 *
 * A module singleton with a `subscribe`/`getSnapshot` store, mirroring
 * `queue-manager`, so a run survives navigation away from the Updates page and
 * any view can watch it without polling the database.
 *
 * The dangerous part of this feature is traffic, not correctness: a run touches
 * every favourite in a row, all against a handful of hosts that rate-limit by
 * IP. Everything below is arranged around that — one series at a time per
 * source, a deliberate gap between requests, and a failure that never takes the
 * rest of the run down with it.
 */

import {
  chapterFiltersKey,
  parseChapterFilters,
  scanlatorKey,
} from '@/lib/chapters/filter-state'
import { DEFAULT_LIBRARY_FILTERS, queryLibrary } from '@/lib/db/library'
import type { LibraryEntry, LibraryFilters } from '@/lib/db/library'
import {
  getSetting,
  getSettings,
  listChapterUrls,
  setSetting,
  upsertChapters,
} from '@/lib/db/repositories'
import { getSource } from '@/lib/sources/registry'
import type { SManga, Source } from '@/lib/sources/types'

/**
 * Minimum gap between two checks against the same source.
 *
 * With `fetchDetails: false` a check is a single request, and the tightest
 * budget among the sources here is Asura's 2 requests per 2 seconds per IP.
 * Sources enforce that themselves through `RateLimiter`, but a library update
 * is the one operation that hits a host dozens of times back to back, so the
 * run keeps a margin of its own: serialised per source and 1.5 s apart, it
 * spends about two thirds of the tightest published budget and leaves the rest
 * for the reader and the download queue instead of queueing behind them.
 *
 * Different sources still run concurrently — the limit is per host, not global.
 */
const SOURCE_INTERVAL_MS = 1_500

/**
 * Series checked at the same time per source.
 *
 * This overlaps *waiting*, not requests: `pace` still releases one request per
 * source every `SOURCE_INTERVAL_MS`, so the rate a host sees is unchanged. What
 * changes is that a slow reply no longer holds the next series back, which is
 * where a sequential sweep spent most of its time. Kept well under what the
 * source's own token bucket would allow, so an update run never monopolises a
 * host against the reader or the download queue.
 */
const SOURCE_CONCURRENCY = 3

/**
 * Longest the published state may lag the run.
 *
 * Every source publishes as each of its series starts and finishes, so a sweep
 * over a large library across several hosts re-renders the runner hundreds of
 * times to move a progress bar a pixel. Terminal states flush immediately, so
 * this only ever delays a count that is about to change again anyway.
 */
const PUBLISH_INTERVAL_MS = 150

// ------------------------------------------------------------ preferences --

/**
 * Mihon's three "skip updating entries" restrictions, all on by default as they
 * are in Mihon. Each one only ever removes work, so a run with all three off is
 * simply a full sweep.
 */
export interface UpdateSkipRules {
  /** Skip a series that still has chapters you have not read. */
  withUnread: boolean
  /** Skip a series you have never opened. */
  notStarted: boolean
  /** Skip a series the source marks as finished. */
  completed: boolean
}

export const DEFAULT_SKIP_RULES: UpdateSkipRules = {
  withUnread: true,
  notStarted: true,
  completed: true,
}

/** `0` means "only when I ask". Everything else is a gap in hours. */
export const UPDATE_INTERVALS = [0, 12, 24, 48, 168] as const

export type UpdateIntervalHours = (typeof UPDATE_INTERVALS)[number]

export const DEFAULT_UPDATE_INTERVAL_HOURS: UpdateIntervalHours = 24

export interface UpdatePrefs {
  rules: UpdateSkipRules
  /** `null` means every favourite, whatever its categories. */
  categoryId: string | null
  intervalHours: UpdateIntervalHours
}

export const DEFAULT_UPDATE_PREFS: UpdatePrefs = {
  rules: DEFAULT_SKIP_RULES,
  categoryId: null,
  intervalHours: DEFAULT_UPDATE_INTERVAL_HOURS,
}

const KEY_SKIP_UNREAD = 'updates.skip_unread'
const KEY_SKIP_NOT_STARTED = 'updates.skip_not_started'
const KEY_SKIP_COMPLETED = 'updates.skip_completed'
const KEY_CATEGORY = 'updates.category'
const KEY_INTERVAL = 'updates.interval_hours'
const KEY_LAST_RUN = 'updates.last_run_at'
const KEY_LAST_SEEN = 'updates.last_seen_at'

export const updatePrefsQueryKey = ['db', 'settings', 'updates'] as const

/** Falls back to the defaults rather than failing: the database may be down. */
export async function loadUpdatePrefs(): Promise<UpdatePrefs> {
  try {
    const [unread, notStarted, completed, categoryId, interval] =
      await Promise.all([
        getSetting(KEY_SKIP_UNREAD),
        getSetting(KEY_SKIP_NOT_STARTED),
        getSetting(KEY_SKIP_COMPLETED),
        getSetting(KEY_CATEGORY),
        getSetting(KEY_INTERVAL),
      ])

    return {
      rules: {
        withUnread: boolOf(unread, DEFAULT_SKIP_RULES.withUnread),
        notStarted: boolOf(notStarted, DEFAULT_SKIP_RULES.notStarted),
        completed: boolOf(completed, DEFAULT_SKIP_RULES.completed),
      },
      categoryId: categoryId || null,
      intervalHours: intervalOf(interval),
    }
  } catch {
    return DEFAULT_UPDATE_PREFS
  }
}

/** A preference that will not persist is not a reason to break the page. */
export async function saveUpdatePrefs(patch: Partial<UpdatePrefs>): Promise<void> {
  const writes: Promise<void>[] = []

  if (patch.rules) {
    writes.push(
      setSetting(KEY_SKIP_UNREAD, patch.rules.withUnread ? '1' : '0'),
      setSetting(KEY_SKIP_NOT_STARTED, patch.rules.notStarted ? '1' : '0'),
      setSetting(KEY_SKIP_COMPLETED, patch.rules.completed ? '1' : '0'),
    )
  }
  if (patch.categoryId !== undefined) {
    writes.push(setSetting(KEY_CATEGORY, patch.categoryId ?? ''))
  }
  if (patch.intervalHours !== undefined) {
    writes.push(setSetting(KEY_INTERVAL, String(patch.intervalHours)))
  }

  await Promise.all(writes)
}

export async function getLastRunAt(): Promise<number | null> {
  return await readTimestamp(KEY_LAST_RUN)
}

export async function getLastSeenAt(): Promise<number | null> {
  return await readTimestamp(KEY_LAST_SEEN)
}

/** Moves the "new since your last visit" marker to now. */
export async function markUpdatesSeen(at = Date.now()): Promise<void> {
  await setSetting(KEY_LAST_SEEN, String(at))
}

/**
 * Whether the configured interval has elapsed. There is no background
 * scheduling — a tab cannot be relied on to run a timer while it is closed or
 * discarded — so this is only ever consulted while the app is open.
 */
export function isUpdateDue(
  intervalHours: UpdateIntervalHours,
  lastRunAt: number | null,
  now = Date.now(),
): boolean {
  if (intervalHours === 0) return false
  if (lastRunAt === null) return true
  return now - lastRunAt >= intervalHours * 60 * 60 * 1000
}

async function readTimestamp(key: string): Promise<number | null> {
  try {
    const parsed = Number.parseInt((await getSetting(key)) ?? '', 10)
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

function boolOf(raw: string | null, fallback: boolean): boolean {
  if (raw === '1') return true
  if (raw === '0') return false
  return fallback
}

function intervalOf(raw: string | null): UpdateIntervalHours {
  const parsed = Number.parseInt(raw ?? '', 10)
  const match = UPDATE_INTERVALS.find((value) => value === parsed)
  return match ?? DEFAULT_UPDATE_INTERVAL_HOURS
}

// ------------------------------------------------------------------ state --

export type UpdateRunStatus = 'idle' | 'running'

export type SkipReason = 'unread' | 'not-started' | 'completed'

export type SkipCounts = Record<SkipReason, number>

export interface UpdateFailure {
  mangaId: string
  title: string
  sourceId: string
  sourceName: string
  message: string
}

export interface UpdateSummary {
  startedAt: number
  finishedAt: number
  /** True when the user cancelled, so the counts are partial by design. */
  cancelled: boolean
  /** Series the run reached, failures included. */
  checked: number
  /** Series the run was going to reach before it stopped. */
  planned: number
  skipped: SkipCounts
  newChapters: number
  seriesUpdated: number
  failures: readonly UpdateFailure[]
  /** Set when the run could not start at all — almost always the database. */
  error: string | null
}

export interface UpdateRuntimeState {
  status: UpdateRunStatus
  /** Series in the plan; 0 until the plan has been read from the database. */
  total: number
  completed: number
  newChapters: number
  /** The series being checked, one per source running in parallel. */
  current: readonly string[]
  failures: readonly UpdateFailure[]
  /** Result of the last finished run, until it is dismissed. */
  summary: UpdateSummary | null
  revision: number
}

export interface RunUpdateOptions {
  /** Omit to use the stored preference; `null` means every favourite. */
  categoryId?: string | null
  /** Omit to use the stored preferences. */
  rules?: UpdateSkipRules
  /**
   * Narrows the plan to these series, by manga id. Used to retry what failed:
   * they passed the skip rules once already, so the run repeats that decision
   * rather than re-taking it against a library the run itself has changed.
   */
  only?: readonly string[]
  /** Cancels the run, in addition to `updateManager.cancel()`. */
  signal?: AbortSignal
}

const NO_SKIPS: SkipCounts = { unread: 0, 'not-started': 0, completed: 0 }

const IDLE_STATE: UpdateRuntimeState = {
  status: 'idle',
  total: 0,
  completed: 0,
  newChapters: 0,
  current: [],
  failures: [],
  summary: null,
  revision: 0,
}

interface UpdatePlan {
  entries: LibraryEntry[]
  skipped: SkipCounts
}

/** What a run would cover, read from the library without touching a source. */
export interface UpdatePreview {
  planned: number
  skipped: SkipCounts
}

class UpdateManager {
  private readonly listeners = new Set<() => void>()
  private state: UpdateRuntimeState = IDLE_STATE
  private revision = 0

  private inFlight: Promise<UpdateSummary> | null = null
  private controller: AbortController | null = null
  /**
   * Tracked separately from `inFlight`: the promise is only assigned once
   * `execute` has yielded, and the run has to read as running from its first
   * publish rather than a tick later.
   */
  private running = false

  private total = 0
  private completed = 0
  private newChapters = 0
  private seriesUpdated = 0
  private skipped: SkipCounts = NO_SKIPS
  private failures: UpdateFailure[] = []
  private summary: UpdateSummary | null = null

  /** Series being checked, keyed by source and series id — several per host. */
  private readonly current = new Map<string, string>()
  /** Next free request slot per source, for the pacing gap. */
  private readonly lastRequest = new Map<string, number>()
  /** Pending coalesced publish, if one is already scheduled. */
  private publishTimer: ReturnType<typeof setTimeout> | null = null

  // ------------------------------------------------------------- the store --

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getSnapshot = (): UpdateRuntimeState => this.state

  /**
   * Publishes at most once per `PUBLISH_INTERVAL_MS`.
   *
   * For the per-series churn only. Anything the reader is waiting on — the plan
   * arriving, the run ending — calls `publish` directly, which also cancels
   * whatever this had queued so the two cannot land out of order.
   */
  private schedulePublish(): void {
    if (this.publishTimer) return
    this.publishTimer = globalThis.setTimeout(() => {
      this.publishTimer = null
      this.publish()
    }, PUBLISH_INTERVAL_MS)
  }

  private publish(): void {
    if (this.publishTimer) {
      globalThis.clearTimeout(this.publishTimer)
      this.publishTimer = null
    }
    this.revision += 1
    this.state = {
      status: this.running ? 'running' : 'idle',
      total: this.total,
      completed: this.completed,
      newChapters: this.newChapters,
      current: [...this.current.values()],
      failures: this.failures,
      summary: this.summary,
      revision: this.revision,
    }
    for (const listener of [...this.listeners]) listener()
  }

  // ------------------------------------------------------------------- api --

  /** Concurrent calls join the run already in progress rather than starting one. */
  runUpdate(options: RunUpdateOptions = {}): Promise<UpdateSummary> {
    const existing = this.inFlight
    if (existing) return existing

    this.running = true
    const run = this.execute(options).finally(() => {
      this.inFlight = null
    })
    this.inFlight = run
    return run
  }

  /**
   * Stops the run. The signal reaches `fetch` through `getMangaUpdate`, so the
   * request in flight is aborted rather than left to run to completion.
   */
  cancel(): void {
    this.controller?.abort()
  }

  /** The plan a run would use, so the page can show it before anything is fetched. */
  async previewUpdate(options: RunUpdateOptions = {}): Promise<UpdatePreview> {
    const plan = await this.plan(options)
    return { planned: plan.entries.length, skipped: plan.skipped }
  }

  dismissSummary(): void {
    if (!this.summary) return
    this.summary = null
    this.publish()
  }

  // ------------------------------------------------------------- the run --

  private async execute(options: RunUpdateOptions): Promise<UpdateSummary> {
    const startedAt = Date.now()
    this.reset()

    const controller = new AbortController()
    this.controller = controller
    linkAbort(options.signal, controller)
    this.publish()

    let plan: UpdatePlan
    try {
      plan = await this.plan(options)
    } catch (error) {
      return this.finish(startedAt, controller, messageOf(error))
    }

    this.total = plan.entries.length
    this.skipped = plan.skipped
    this.publish()

    try {
      // One statement for the whole plan, before any source is touched. Read
      // per series this was a worker round trip each, against a database the
      // reader and the download queue are already queueing behind.
      const followed = await this.followedGroups(plan.entries)
      await Promise.all(
        [...groupBySource(plan.entries)].map(([sourceId, entries]) =>
          this.runSource(sourceId, entries, followed, controller.signal),
        ),
      )
    } catch (error) {
      // `runSource` handles its own failures, so reaching here means something
      // unforeseen. It still has to leave the runtime idle and reusable.
      return this.finish(startedAt, controller, messageOf(error))
    }

    const summary = this.finish(startedAt, controller, null)
    // Only a run that finished on its own counts towards the interval: a
    // cancelled sweep, or one that died on a dead database, should not push the
    // next automatic check a day out.
    if (!summary.cancelled) {
      void setSetting(KEY_LAST_RUN, String(summary.finishedAt)).catch(
        () => undefined,
      )
    }
    return summary
  }

  /**
   * Turns the library into the list of series to check.
   *
   * The skip rules are exactly the library's own tri-state filters, so both the
   * category scoping and the restrictions are one grouped query each. The
   * unfiltered pass is what makes the summary able to say how many series were
   * skipped and for which reason.
   */
  private async plan(options: RunUpdateOptions): Promise<UpdatePlan> {
    const stored = await loadUpdatePrefs()
    const rules = options.rules ?? stored.rules
    const categoryId =
      options.categoryId === undefined ? stored.categoryId : options.categoryId

    const filters: LibraryFilters = {
      ...DEFAULT_LIBRARY_FILTERS,
      unread: rules.withUnread ? 2 : 0,
      started: rules.notStarted ? 1 : 0,
      completed: rules.completed ? 2 : 0,
    }

    const [candidates, matched] = await Promise.all([
      queryLibrary({ categoryId }),
      queryLibrary({ categoryId, filters }),
    ])

    const allowed = new Set(matched.map((entry) => entry.id))
    const skipped: SkipCounts = { ...NO_SKIPS }

    for (const entry of candidates) {
      if (allowed.has(entry.id)) continue
      // Ordered most specific first: a series that was never started also has
      // unread chapters, and a finished one may have both.
      if (rules.completed && entry.status === 'completed') skipped.completed += 1
      else if (rules.withUnread && entry.unreadCount > 0) skipped.unread += 1
      else skipped['not-started'] += 1
    }

    // A retry narrows what is checked and nothing else: the skip counts stay
    // the ones the original sweep reported.
    const only = options.only ? new Set(options.only) : null
    const entries = only
      ? matched.filter((entry) => only.has(entry.id))
      : matched

    return { entries, skipped }
  }

  /** One source, a few series at a time, paced. Never throws. */
  private async runSource(
    sourceId: string,
    entries: readonly LibraryEntry[],
    followed: Map<string, string[]>,
    signal: AbortSignal,
  ): Promise<void> {
    let source: Source | null = null
    let unavailable: string | null = null
    try {
      source = getSource(sourceId)
    } catch (error) {
      unavailable = messageOf(error)
    }

    // A shared cursor rather than a slice per worker: series take wildly
    // different times, and handing out the next one on demand keeps every
    // worker busy instead of leaving one with a queue the others cannot take.
    let cursor = 0
    const workers = Math.min(SOURCE_CONCURRENCY, entries.length)

    const worker = async (): Promise<void> => {
      for (;;) {
        if (signal.aborted) return
        const entry = entries[cursor]
        if (!entry) return
        cursor += 1

        if (!source) {
          this.recordFailure(
            entry,
            sourceId,
            sourceId,
            unavailable ?? 'Unknown source.',
          )
          this.completed += 1
          this.schedulePublish()
          continue
        }

        await this.pace(sourceId, signal)
        if (signal.aborted) return

        const key = `${sourceId}:${entry.id}`
        this.current.set(key, entry.title)
        this.schedulePublish()

        try {
          const added = await this.checkOne(
            source,
            entry,
            followed.get(entry.id) ?? [],
            signal,
          )
          if (added > 0) {
            this.newChapters += added
            this.seriesUpdated += 1
          }
        } catch (error) {
          // The request is now abortable, so a cancelled run rejects here. That
          // is the user stopping the sweep, not the series failing to update:
          // recording it would put a spurious entry in the summary's failures.
          if (signal.aborted) {
            this.current.delete(key)
            return
          }
          this.recordFailure(entry, sourceId, source.name, messageOf(error))
        }

        this.completed += 1
        this.current.delete(key)
        this.schedulePublish()
      }
    }

    await Promise.all(Array.from({ length: workers }, worker))

    // A cancelled worker leaves its series in the label; clear whatever this
    // source still holds rather than assuming a single key.
    for (const key of this.current.keys()) {
      if (key.startsWith(`${sourceId}:`)) this.current.delete(key)
    }
    this.publish()
  }

  /**
   * The groups each series is being followed from, for the whole plan at once.
   * A series absent from the map follows all of them.
   *
   * An aggregator carries the same series from several groups, and a reader
   * following one of them does not want the other four interrupting. The
   * choice already exists per series — it is what the chapter list is filtered
   * by — so it is read back here rather than duplicated as its own setting.
   *
   * Chapters from other groups are skipped entirely rather than stored and
   * hidden: the Updates feed reads the chapter table directly, so a row that
   * exists is a row that shows up.
   */
  private async followedGroups(
    entries: readonly LibraryEntry[],
  ): Promise<Map<string, string[]>> {
    const followed = new Map<string, string[]>()
    try {
      const keys = entries.map((entry) =>
        chapterFiltersKey(entry.sourceId, entry.url),
      )
      const stored = await getSettings(keys)
      for (const entry of entries) {
        const raw = stored.get(chapterFiltersKey(entry.sourceId, entry.url))
        if (!raw) continue
        const scanlators = parseChapterFilters(raw).scanlators
        if (scanlators.length > 0) followed.set(entry.id, scanlators)
      }
    } catch {
      // A missing or unreadable preference means no narrowing, which is the
      // same answer as never having chosen a group.
      return new Map()
    }
    return followed
  }

  /** Returns how many chapters were new. Details are deliberately not refetched. */
  private async checkOne(
    source: Source,
    entry: LibraryEntry,
    followed: readonly string[],
    signal: AbortSignal,
  ): Promise<number> {
    // The stored urls do not depend on the reply, so reading them alongside the
    // request takes the round trip off the series' critical path rather than
    // spending it after every fetch.
    const [update, known] = await Promise.all([
      source.getMangaUpdate(
        toSManga(entry),
        { fetchDetails: false, fetchChapters: true },
        signal,
      ),
      listChapterUrls(entry.id).then((urls) => new Set(urls)),
    ])
    if (signal.aborted) return 0

    const fresh = update.chapters.filter(
      (chapter) =>
        !known.has(chapter.url) &&
        (followed.length === 0 ||
          followed.includes(scanlatorKey(chapter.scanlator))),
    )
    if (fresh.length === 0) return 0

    // Only the new ones: an upsert of the whole list would be one round trip
    // per chapter and would touch every stored row for nothing.
    await upsertChapters(entry.id, fresh)
    return fresh.length
  }

  /**
   * Reserves the next request slot for this source.
   *
   * The slot is claimed synchronously, before any `await`, so concurrent
   * workers on the same source are handed staggered start times instead of all
   * reading the same "last request" and firing together.
   */
  private async pace(sourceId: string, signal: AbortSignal): Promise<void> {
    const now = Date.now()
    const previous = this.lastRequest.get(sourceId)
    const slot =
      previous === undefined ? now : Math.max(now, previous + SOURCE_INTERVAL_MS)
    this.lastRequest.set(sourceId, slot)
    if (slot > now) await sleep(slot - now, signal)
  }

  private recordFailure(
    entry: LibraryEntry,
    sourceId: string,
    sourceName: string,
    message: string,
  ): void {
    // Replaced rather than mutated: the array is handed straight to React.
    this.failures = [
      ...this.failures,
      { mangaId: entry.id, title: entry.title, sourceId, sourceName, message },
    ]
  }

  private reset(): void {
    this.total = 0
    this.completed = 0
    this.newChapters = 0
    this.seriesUpdated = 0
    this.skipped = NO_SKIPS
    this.failures = []
    this.summary = null
    this.current.clear()
    this.lastRequest.clear()
  }

  private finish(
    startedAt: number,
    controller: AbortController,
    error: string | null,
  ): UpdateSummary {
    const summary: UpdateSummary = {
      startedAt,
      finishedAt: Date.now(),
      cancelled: controller.signal.aborted,
      checked: this.completed,
      planned: this.total,
      skipped: this.skipped,
      newChapters: this.newChapters,
      seriesUpdated: this.seriesUpdated,
      failures: this.failures,
      error,
    }

    this.controller = null
    this.running = false
    this.summary = summary
    this.current.clear()
    this.publish()
    return summary
  }
}

// --------------------------------------------------------------- helpers --

function groupBySource(
  entries: readonly LibraryEntry[],
): Map<string, LibraryEntry[]> {
  const groups = new Map<string, LibraryEntry[]>()
  for (const entry of entries) {
    const bucket = groups.get(entry.sourceId)
    if (bucket) bucket.push(entry)
    else groups.set(entry.sourceId, [entry])
  }
  return groups
}

/** The stored row rebuilt as the source-shaped value `getMangaUpdate` expects. */
function toSManga(entry: LibraryEntry): SManga {
  return {
    url: entry.url,
    title: entry.title,
    author: entry.author ?? undefined,
    artist: entry.artist ?? undefined,
    description: entry.description ?? undefined,
    genre: entry.genres ?? undefined,
    status: entry.status,
    thumbnailUrl: entry.thumbnailUrl ?? undefined,
    initialized: true,
    // Carries source-private state such as Asura's randomised slug, without
    // which the chapter request would be built from the wrong url.
    memo: entry.memo ?? undefined,
  }
}

function linkAbort(
  signal: AbortSignal | undefined,
  controller: AbortController,
): void {
  if (!signal) return
  if (signal.aborted) {
    controller.abort()
    return
  }
  signal.addEventListener('abort', () => controller.abort(), { once: true })
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const settle = () => {
      globalThis.clearTimeout(timer)
      signal.removeEventListener('abort', settle)
      resolve()
    }
    const timer = globalThis.setTimeout(settle, ms)
    signal.addEventListener('abort', settle, { once: true })
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const updateManager = new UpdateManager()
