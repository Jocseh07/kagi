/**
 * Runtime that drains the download queue.
 *
 * Scheduling only: the saving itself belongs to `saveChapter`, and every piece
 * of queue bookkeeping belongs to `queue-repository`. What lives here is the
 * decision of *what to run next*, an `AbortController` per item, and a small
 * store so React can watch the runtime without polling the database.
 *
 * It is a module singleton rather than a hook because the queue has to keep
 * going while the user navigates away from the downloads page. Views start it
 * and subscribe; nothing stops it on unmount. It stops itself once the queue
 * drains, and any enqueue can wake it again with `nudge()`.
 */

import { getFlag, getManga, getSetting, listChapters } from '@/lib/db/repositories'
import {
  backgroundFetchIdFor,
  cancelBackgroundFetch,
  primeBackgroundFetch,
} from '@/lib/offline/background-fetch'
import { backgroundDownloadsAvailable, saveChapter } from '@/lib/offline/save-chapter'
import { saveChapterTextOffline } from '@/lib/offline/save-text'
import { SUSPEND_ABORT_REASON } from '@/lib/offline/types'
import type { SaveChapterResult, SaveProgress } from '@/lib/offline/types'
import { getSource } from '@/lib/sources/registry'
import { isPrimableTextSource, isTextSource, kindOf } from '@/lib/sources/types'
import type { SChapter, SManga, Source, TextSource } from '@/lib/sources/types'

import {
  listQueue,
  nextQueued,
  pauseAll,
  rehydrateOnBoot,
  removeItem,
  resumeAll,
  setItemState,
  updateItemProgress,
} from './queue-repository'
import {
  PRIME_COMIC_BATCH,
  PRIME_NOVEL_BATCH,
  DEFAULT_MANGA_CONCURRENCY,
  DEFAULT_NOVEL_CONCURRENCY,
  DEFAULT_QUEUE_CONCURRENCY,
  MAX_ATTEMPTS,
  SETTING_AUTO_CLEAR_FINISHED,
  SETTING_MANGA_CONCURRENCY,
  SETTING_NOVEL_CONCURRENCY,
  SETTING_QUEUE_CONCURRENCY,
  normaliseConcurrency,
  normaliseMangaConcurrency,
  normaliseNovelConcurrency,
} from './queue-types'
import type { QueueItem } from './queue-types'

/** How often the loop looks for new work while it has something to do. */
const POLL_INTERVAL_MS = 2_000

/** Floor on progress writes: each one is a transaction plus an oplog row. */
const PROGRESS_WRITE_INTERVAL_MS = 1_000

/** Backoff before a requeued item is picked up again, multiplied by attempts. */
const RETRY_BACKOFF_MS = 5_000

/**
 * Rows fetched per pass on top of the free slots.
 *
 * Candidates still inside their retry backoff are skipped, so a window the size
 * of the free slots would stall behind a run of recently failed chapters.
 */
const CANDIDATE_SLACK = 8

/** `suspended`: stopped by the app going to the background, restarts on return. */
export type QueueRuntimeStatus = 'stopped' | 'running' | 'halted' | 'suspended'

export interface QueueHalt {
  /** `quota` stopped the batch deliberately; `database` means writes failed. */
  reason: 'quota' | 'database'
  message: string
}

export interface QueueRuntimeState {
  status: QueueRuntimeStatus
  halt: QueueHalt | null
  activeItemIds: readonly string[]
  /** Bumped whenever queue rows may have changed, so views can refetch. */
  revision: number
  /**
   * Chapters saved since this page loaded. Separate from `revision` so views
   * can invalidate the expensive library queries only when one actually lands.
   */
  completions: number
}

/** Why an in-flight save was aborted, which decides what its row becomes. */
type AbortCause = 'paused' | 'stopped' | 'removed' | 'suspended'

interface InFlight {
  item: QueueItem
  controller: AbortController
  cause: AbortCause | null
  /** True once the row has been written as `active`; see `reconcile`. */
  marked: boolean
}

const IDLE_STATE: QueueRuntimeState = {
  status: 'stopped',
  halt: null,
  activeItemIds: [],
  revision: 0,
  completions: 0,
}

class QueueManager {
  private running = false
  private booted = false
  private halted: QueueHalt | null = null
  /** Set by a hide while the page drives the downloads; cleared on return. */
  private suspended = false
  /** Read once per drain: whether saves go to Background Fetch. */
  private backgroundFetch = false
  private completions = 0
  private revision = 0
  private concurrency = DEFAULT_QUEUE_CONCURRENCY
  /** Same ceiling for a novel series, which is configured separately. */
  private novelConcurrency = DEFAULT_NOVEL_CONCURRENCY
  /** How many distinct series may have chapters in flight at once. */
  private mangaConcurrency = DEFAULT_MANGA_CONCURRENCY
  /** Opt-in: false until a stored `'1'` or an explicit switch says otherwise. */
  private autoClear = false

  private readonly inFlight = new Map<string, InFlight>()
  /**
   * Queued rows already handed to Background Fetch, item id to chapter id.
   * Session-scoped: a reload re-primes, and the registration lookup makes
   * that a no-op for runs the browser still holds.
   */
  private readonly primed = new Map<string, string>()
  /** Rows the last pass could not prime yet; keeps the loop alive for them. */
  private unprimed = 0
  /** Item id to the earliest time it may be picked up again. */
  private readonly cooldowns = new Map<string, number>()
  private readonly listeners = new Set<() => void>()

  private state: QueueRuntimeState = IDLE_STATE
  private waker: (() => void) | null = null

  // ------------------------------------------------------------- the store --

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getSnapshot = (): QueueRuntimeState => this.state

  /**
   * What the store looks like during the shell prerender.
   *
   * There is no download runtime on the server, so idle is not a placeholder
   * but the truth. It has to be this shared constant rather than a fresh
   * object: `useSyncExternalStore` compares identity, and a new one per call
   * is an infinite render loop.
   */
  readonly getServerSnapshot = (): QueueRuntimeState => IDLE_STATE

  private publish(): void {
    this.revision += 1
    this.state = {
      status: this.halted
        ? 'halted'
        : this.running
          ? 'running'
          : this.suspended
            ? 'suspended'
            : 'stopped',
      halt: this.halted,
      activeItemIds: [...this.inFlight.keys()],
      revision: this.revision,
      completions: this.completions,
    }
    for (const listener of [...this.listeners]) listener()
  }

  // ------------------------------------------------------------------ api --

  start(): void {
    if (this.running || this.halted) return
    this.suspended = false
    this.running = true
    this.publish()
    void this.drain()
  }

  /** Leaves rows untouched: an aborted save goes back to `queued`. */
  stop(): void {
    if (!this.running) return
    this.running = false
    this.abortAll('stopped')
    this.dropPrimed()
    this.wake()
    this.publish()
  }

  /** Wakes a sleeping loop, or starts one, after rows were added elsewhere. */
  nudge(): void {
    if (this.running) {
      this.wake()
      return
    }
    this.start()
  }

  async pause(): Promise<void> {
    this.suspended = false
    try {
      await pauseAll()
    } catch (error) {
      this.haltWith('database', messageOf(error))
      return
    }
    // The rows are already `paused`, so the aborted saves have nothing to
    // write back; the loop then finds nothing queued and winds itself down.
    this.abortAll('paused')
    this.dropPrimed()
    this.publish()
  }

  async resume(): Promise<void> {
    // Resuming is also how the user acknowledges a halt and tries again.
    this.halted = null
    try {
      await resumeAll()
    } catch (error) {
      this.haltWith('database', messageOf(error))
      return
    }
    this.start()
  }

  /** Called by views after `removeItem`, so an in-flight save stops too. */
  cancelItem(id: string): void {
    const chapterId = this.primed.get(id)
    if (chapterId !== undefined) {
      this.primed.delete(id)
      void cancelBackgroundFetch(backgroundFetchIdFor(chapterId))
    }
    const record = this.inFlight.get(id)
    if (!record) return
    record.cause = 'removed'
    record.controller.abort()
  }

  /**
   * Applies a concurrency change made in Settings without waiting for a reload.
   *
   * Only the ceiling on new work moves. Chapters already in flight are left to
   * finish, so narrowing the queue never throws away a part-fetched chapter.
   */
  setConcurrency(value: number): void {
    this.concurrency = normaliseConcurrency(value)
    this.wake()
  }

  /** The novel-side counterpart of `setConcurrency`, with the same semantics. */
  setNovelConcurrency(value: number): void {
    this.novelConcurrency = normaliseNovelConcurrency(value)
    this.wake()
  }

  /**
   * Applies a series-parallelism change made in Settings, same as above:
   * only the ceiling on new work moves, in-flight chapters are left alone.
   */
  setMangaConcurrency(value: number): void {
    this.mangaConcurrency = normaliseMangaConcurrency(value)
    this.wake()
  }

  /**
   * Applies the auto-clear switch to a queue that is already running.
   *
   * Only chapters that finish from here on are affected; rows that already
   * settled are the user's to clear, which is why nothing is swept on the way
   * in — see `SETTING_AUTO_CLEAR_FINISHED`.
   */
  setAutoClearFinished(value: boolean): void {
    this.autoClear = value
  }

  // ------------------------------------------------------------- the loop --

  private async drain(): Promise<void> {
    if (!this.booted) {
      try {
        // An `active` row on boot is interrupted work, not work in progress:
        // whatever was fetching for it died with the previous page.
        await rehydrateOnBoot()
        this.booted = true
      } catch (error) {
        this.haltWith('database', messageOf(error))
        return
      }
    }

    // Once per drain rather than once per pass: a loop that wound down and
    // woke again picks up a changed setting, without a query every two seconds.
    this.concurrency = await this.readConcurrency()
    this.novelConcurrency = await this.readNovelConcurrency()
    this.mangaConcurrency = await this.readMangaConcurrency()
    this.autoClear = await getFlag(SETTING_AUTO_CLEAR_FINISHED)
    this.backgroundFetch = await backgroundDownloadsAvailable()

    while (this.running) {
      let hasWork: boolean
      try {
        hasWork = await this.tick()
      } catch (error) {
        this.haltWith('database', messageOf(error))
        return
      }

      if (!this.running) break
      if (!hasWork) {
        this.running = false
        break
      }
      await this.nap(POLL_INTERVAL_MS)
    }

    this.publish()
  }

  /** One pass. Returns whether anything is still outstanding. */
  private async tick(): Promise<boolean> {
    await this.reconcile()
    const candidates = await this.fill()
    await this.prime()
    return this.inFlight.size > 0 || candidates > 0 || this.unprimed > 0
  }

  /**
   * Hands every queued chapter to Background Fetch ahead of its turn.
   *
   * The loop itself is frozen with the page when the screen locks, so anything
   * not already given to the browser waits for an unlock. Each pass registers
   * a batch more, paced by kind (`PRIME_COMIC_BATCH`, `PRIME_NOVEL_BATCH`);
   * when a row becomes active, `savePages` or `saveChapterTextOffline` adopts
   * the run or its downloaded body instead of starting over. Best effort per
   * row: a failure here is retried by the ordinary path when the turn comes.
   * Local-file novels have nothing to hand off and are skipped.
   */
  private async prime(): Promise<void> {
    this.unprimed = 0
    if (!(await backgroundDownloadsAvailable())) return

    const now = Date.now()
    let comics = 0
    let novels = 0

    for (const item of await nextQueued(Number.MAX_SAFE_INTEGER)) {
      if (this.inFlight.has(item.id) || this.primed.has(item.id)) continue
      if ((this.cooldowns.get(item.id) ?? 0) > now) continue

      const source = getSource(item.sourceId)
      const text = isTextSource(source)
      if (text && !isPrimableTextSource(source)) continue

      const full = text
        ? novels >= PRIME_NOVEL_BATCH
        : comics >= PRIME_COMIC_BATCH
      if (full) {
        this.unprimed += 1
        continue
      }
      if (text) novels += 1
      else comics += 1

      this.primed.set(item.id, item.chapterId)
      await this.primeItem(item)
      if (!this.running) return
    }
  }

  private async primeItem(item: QueueItem): Promise<void> {
    try {
      const source = getSource(item.sourceId)
      const subject = await this.subjectOf(item)
      const title = `${item.mangaTitle} — ${item.chapterName}`

      if (isPrimableTextSource(source)) {
        await primeBackgroundFetch({
          id: backgroundFetchIdFor(item.chapterId),
          urls: [source.chapterTextUrl(subject.manga, subject.chapter)],
          title,
        })
        return
      }

      const pages = await source.getPageList(subject.manga, subject.chapter)
      if (pages.length === 0) return
      await this.write(() =>
        setItemState(item.id, 'queued', { pagesTotal: pages.length }),
      )
      if (this.halted) return
      await primeBackgroundFetch({
        id: backgroundFetchIdFor(item.chapterId),
        urls: pages.map((page) => page.imageUrl),
        title,
      })
    } catch {
      // Left to the ordinary path: the row is still `queued` and will be
      // fetched when it goes active, with its own error handling.
      this.primed.delete(item.id)
    }
  }

  /** Aborts every primed run, for a pause or a stop. */
  private dropPrimed(): void {
    for (const chapterId of this.primed.values()) {
      void cancelBackgroundFetch(backgroundFetchIdFor(chapterId))
    }
    this.primed.clear()
  }

  /**
   * Aborts in-flight saves whose row moved out from under them.
   *
   * `pauseAll` flips `active` rows to `paused` as well, and it can be called
   * from anywhere, so the runtime cannot rely on having initiated the pause
   * itself. Only rows already written as `active` are checked: a record picked
   * up moments ago still reads as `queued`.
   */
  private async reconcile(): Promise<void> {
    const watched = [...this.inFlight.values()].filter(
      (record) => record.marked && record.cause === null,
    )
    if (watched.length === 0) return

    const rows = new Map((await listQueue()).map((row) => [row.id, row]))
    for (const record of watched) {
      const row = rows.get(record.item.id)
      if (!row) {
        record.cause = 'removed'
        record.controller.abort()
        continue
      }
      if (row.state !== 'active') {
        record.cause = 'paused'
        record.controller.abort()
      }
    }
  }

  /**
   * Starts as many items as the free slots allow, in queue order.
   *
   * The binding constraint is the source's own rate limit, not the browser:
   * Asura permits 2 requests per 2 seconds. Page images are fetched by the
   * service worker, which never passes through the source's limiter, so the
   * worker paces them itself — and it does so per origin across every run at
   * once (`takeTurn` in public/sw.js), not per run. Parallel chapters of one
   * source therefore interleave inside the host's limit instead of each
   * claiming the full rate, which is what lets the configured concurrency apply
   * whatever mix of sources the queue holds.
   *
   * Work is spread across series rather than taken strictly in queue order: a
   * series may hold as many chapters as its own kind allows, and only
   * `mangaConcurrency` series run at once, so a long backlog of one series
   * never starves the rest.
   */
  private async fill(): Promise<number> {
    // The two kinds have separate per-series limits, so the overall ceiling has
    // to assume the wider one; the per-row check below applies the right one.
    const widest = Math.max(this.concurrency, this.novelConcurrency)
    const ceiling = widest * this.mangaConcurrency
    const free = ceiling - this.inFlight.size
    if (free <= 0) return 0

    const perManga = new Map<string, number>()
    for (const record of this.inFlight.values()) {
      const mangaId = record.item.mangaId
      perManga.set(mangaId, (perManga.get(mangaId) ?? 0) + 1)
    }

    const candidates = await nextQueued(ceiling + CANDIDATE_SLACK)
    const now = Date.now()
    let started = 0

    for (const item of candidates) {
      if (started >= free) break
      if (this.inFlight.has(item.id)) continue
      if ((this.cooldowns.get(item.id) ?? 0) > now) continue

      const running = perManga.get(item.mangaId) ?? 0
      if (running >= this.limitFor(item)) continue
      if (running === 0 && perManga.size >= this.mangaConcurrency) continue

      perManga.set(item.mangaId, running + 1)
      started += 1
      this.begin(item)
    }

    return candidates.length
  }

  private begin(item: QueueItem): void {
    const record: InFlight = {
      item,
      controller: new AbortController(),
      cause: null,
      marked: false,
    }
    this.inFlight.set(item.id, record)
    this.cooldowns.delete(item.id)
    // Its run is now owned by the save; adoption happens in `savePages`.
    this.primed.delete(item.id)
    this.publish()
    void this.process(record)
  }

  // ------------------------------------------------------------- one item --

  private async process(record: InFlight): Promise<void> {
    const { item, controller } = record

    try {
      await this.write(() =>
        setItemState(item.id, 'active', {
          startedAt: Date.now(),
          pagesCompleted: 0,
          lastError: null,
        }),
      )
      if (this.halted) return
      record.marked = true

      const source = getSource(item.sourceId)
      const subject = await this.subjectOf(item)
      if (controller.signal.aborted) {
        await this.settleAbort(record)
        return
      }

      const result = isTextSource(source)
        ? await this.saveText(record, source, subject)
        : await this.savePages(record, source, subject)

      if (this.halted) return
      if (!result) return

      if (result.ok) {
        await this.write(() =>
          setItemState(item.id, 'done', {
            pagesCompleted: result.pageCount,
            pagesTotal: result.pageCount,
            finishedAt: Date.now(),
            lastError: null,
          }),
        )
        if (this.halted) return
        this.completions += 1
        // The `done` write above stays either way: a delete that fails then
        // leaves an honest finished row rather than one stuck at `active`.
        if (this.autoClear) await this.write(() => removeItem(item.id))
        return
      }

      if (result.reason === 'cancelled') {
        await this.settleAbort(record)
        return
      }

      if (result.reason === 'quota-exceeded') {
        // Retrying is pointless and every remaining item would fail the same
        // way, so the batch stops here and the user is told why.
        await this.write(() =>
          setItemState(item.id, 'failed', {
            attempts: item.attempts + 1,
            lastError: result.message,
            finishedAt: Date.now(),
          }),
        )
        await this.haltForQuota(result.message)
        return
      }

      await this.recordFailure(item, result.message)
    } catch (error) {
      if (controller.signal.aborted) {
        await this.settleAbort(record)
      } else {
        await this.recordFailure(item, messageOf(error))
      }
    } finally {
      this.inFlight.delete(item.id)
      this.publish()
      this.wake()
    }
  }

  /**
   * Comic path: resolve the page list, then hand it to the image saver.
   *
   * Null means the item settled itself (aborted, or the runtime halted) and
   * `process` should stop without interpreting a result.
   */
  private async savePages(
    record: InFlight,
    source: Source,
    subject: { manga: SManga; chapter: SChapter },
  ): Promise<SaveChapterResult | null> {
    const { item, controller } = record
    const pages = await source.getPageList(
      subject.manga,
      subject.chapter,
      controller.signal,
    )
    if (controller.signal.aborted) {
      await this.settleAbort(record)
      return null
    }

    // Written before the save starts: the summary sums `pagesTotal` over
    // unfinished rows, so the projected size reads zero until this lands.
    await this.write(() =>
      setItemState(item.id, 'active', { pagesTotal: pages.length }),
    )
    if (this.halted) return null
    this.publish()

    return await saveChapter(item.chapterId, pages, {
      signal: controller.signal,
      // Names the run in the system download UI when it goes through Background
      // Fetch, where the user sees it outside the app.
      title: `${item.mangaTitle} — ${item.chapterName}`,
      // The worker fetches these images itself, outside the source's limiter.
      minIntervalMs: source.pageFetchIntervalMs,
      onProgress: this.progressWriter(item.id, pages.length),
    })
  }

  /**
   * Novel path: one fetch, one write, no service worker.
   *
   * A chapter of prose is a single unit of work rather than a page list, so the
   * row's totals are set to one up front and the progress writer has nothing to
   * report in between. There is no rate-limit pacing to pass along either — the
   * source's own limiter covers this request, unlike page images, which are
   * fetched by the worker outside it.
   */
  private async saveText(
    record: InFlight,
    source: TextSource,
    subject: { manga: SManga; chapter: SChapter },
  ): Promise<SaveChapterResult | null> {
    const { item, controller } = record

    await this.write(() => setItemState(item.id, 'active', { pagesTotal: 1 }))
    if (this.halted) return null
    this.publish()

    return await saveChapterTextOffline(
      item.chapterId,
      source,
      subject.manga,
      subject.chapter,
      {
        signal: controller.signal,
        onProgress: this.progressWriter(item.id, 1),
      },
    )
  }

  /**
   * Rebuilds the source-shaped manga and chapter a save needs. The queue row
   * carries database ids and display text, not the source payloads.
   */
  private async subjectOf(
    item: QueueItem,
  ): Promise<{ manga: SManga; chapter: SChapter }> {
    const mangaRow = await getManga(item.mangaId)
    if (!mangaRow) {
      throw new Error('This series is no longer in the library database.')
    }

    const chapterRow = (await listChapters(item.mangaId)).find(
      (row) => row.id === item.chapterId,
    )

    const manga: SManga = {
      url: mangaRow.url,
      title: mangaRow.title,
      author: mangaRow.author ?? undefined,
      artist: mangaRow.artist ?? undefined,
      description: mangaRow.description ?? undefined,
      genre: mangaRow.genres ?? undefined,
      status: mangaRow.status,
      thumbnailUrl: mangaRow.thumbnailUrl ?? undefined,
      initialized: true,
      memo: mangaRow.memo ?? undefined,
    }

    const chapter: SChapter = {
      url: item.chapterUrl,
      name: item.chapterName,
      chapterNumber: chapterRow?.chapterNumber ?? -1,
      dateUpload: chapterRow?.dateUpload ?? undefined,
    }

    return { manga, chapter }
  }

  /**
   * Progress reported by `saveChapter` is per page; the row is written at most
   * once a second, and the final counts come from the terminal state anyway.
   *
   * Only the fetch phase is written. It is the slow one — a page a second or
   * worse, since the worker paces itself against the source's rate limit — and
   * it is what the user is waiting on. Verification decodes what is already on
   * disk and is over in moments, so writing its counts too would only send the
   * bar back to zero for a final sprint; the row instead holds at the full
   * page count until the terminal state lands.
   */
  private progressWriter(id: string, total: number): (p: SaveProgress) => void {
    let lastWrite = 0
    return (progress) => {
      if (progress.phase !== 'fetching') return
      const now = Date.now()
      if (now - lastWrite < PROGRESS_WRITE_INTERVAL_MS) return
      lastWrite = now
      void updateItemProgress(id, progress.completed, total).then(
        () => this.publish(),
        // A dropped progress write is cosmetic; the save is still running.
        () => undefined,
      )
    }
  }

  private async recordFailure(item: QueueItem, message: string): Promise<void> {
    const attempts = item.attempts + 1
    if (attempts < MAX_ATTEMPTS) {
      this.cooldowns.set(item.id, Date.now() + attempts * RETRY_BACKOFF_MS)
      await this.write(() =>
        setItemState(item.id, 'queued', {
          attempts,
          lastError: message,
          pagesCompleted: 0,
          startedAt: null,
        }),
      )
      return
    }
    await this.write(() =>
      setItemState(item.id, 'failed', {
        attempts,
        lastError: message,
        finishedAt: Date.now(),
      }),
    )
  }

  /**
   * A cancelled save kept nothing, so only a runtime-initiated stop has to put
   * the row back. A pause already wrote `paused`, and a removal has no row.
   * A suspended save kept its pages, and the row goes back the same way: no
   * attempt is counted, since the interruption was not the chapter's fault.
   */
  private async settleAbort(record: InFlight): Promise<void> {
    if (record.cause === 'paused' || record.cause === 'removed') return
    await this.write(() =>
      setItemState(record.item.id, 'queued', {
        pagesCompleted: 0,
        startedAt: null,
      }),
    )
  }

  private async haltForQuota(message: string): Promise<void> {
    this.abortAll('paused')
    try {
      await pauseAll()
    } catch {
      // The halt is what matters; the rows can be paused by hand.
    }
    this.haltWith('quota', message)
  }

  private haltWith(reason: QueueHalt['reason'], message: string): void {
    this.halted = { reason, message }
    this.suspended = false
    this.running = false
    this.abortAll('stopped')
    this.wake()
    this.publish()
  }

  private abortAll(cause: AbortCause): void {
    for (const record of this.inFlight.values()) {
      record.cause ??= cause
      // The reason is what tells the save to keep its cached pages.
      record.controller.abort(
        cause === 'suspended' ? SUSPEND_ABORT_REASON : undefined,
      )
    }
  }

  /**
   * Stops the page-driven downloads while the app is in the background.
   *
   * A hidden page is throttled, and a backgrounded mobile PWA is frozen, so a
   * save the page itself is driving cannot finish there: it is found timed out
   * or half-done on return and counted as a failure. Stopping it here instead
   * puts the row back to `queued` with its pages kept, and `resumeIfSuspended`
   * picks it up again. Background Fetch runs are the browser's and are left.
   */
  private suspend(): void {
    if (!this.running || this.backgroundFetch) return
    this.running = false
    this.suspended = true
    this.abortAll('suspended')
    this.wake()
    this.publish()
  }

  private resumeIfSuspended(): void {
    if (!this.suspended) return
    this.start()
  }

  /** Every write goes through here: a dead database halts instead of looping. */
  private async write<T>(op: () => Promise<T>): Promise<T | null> {
    try {
      return await op()
    } catch (error) {
      this.haltWith('database', messageOf(error))
      return null
    }
  }

  /**
   * Per-series chapter limit for one row, chosen by what its source serves.
   * An id the registry does not know is treated as a comic, matching the
   * default `contentKind` carries elsewhere.
   */
  private limitFor(item: QueueItem): number {
    try {
      return kindOf(getSource(item.sourceId)) === 'novel'
        ? this.novelConcurrency
        : this.concurrency
    } catch {
      return this.concurrency
    }
  }

  private async readConcurrency(): Promise<number> {
    try {
      return normaliseConcurrency(await getSetting(SETTING_QUEUE_CONCURRENCY))
    } catch {
      return DEFAULT_QUEUE_CONCURRENCY
    }
  }

  private async readNovelConcurrency(): Promise<number> {
    try {
      return normaliseNovelConcurrency(
        await getSetting(SETTING_NOVEL_CONCURRENCY),
      )
    } catch {
      return DEFAULT_NOVEL_CONCURRENCY
    }
  }

  private async readMangaConcurrency(): Promise<number> {
    try {
      return normaliseMangaConcurrency(
        await getSetting(SETTING_MANGA_CONCURRENCY),
      )
    } catch {
      return DEFAULT_MANGA_CONCURRENCY
    }
  }

  private nap(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = globalThis.setTimeout(() => {
        this.waker = null
        resolve()
      }, ms)
      this.waker = () => {
        globalThis.clearTimeout(timer)
        this.waker = null
        resolve()
      }
    })
  }

  private wake(): void {
    this.waker?.()
  }

  /**
   * Catches the loop up the instant the app is looked at again.
   *
   * A hidden page has its timers throttled to about one wake a minute, and a
   * backgrounded mobile PWA is frozen outright, so the nap between passes can
   * outlast the work by a long way. Downloads themselves keep going — that is
   * what Background Fetch is for — but the queue would otherwise take up to a
   * minute to notice they had, and to start the next chapter.
   */
  watchVisibility(): () => void {
    if (typeof document === 'undefined') return () => undefined
    const onChange = (): void => {
      if (document.visibilityState !== 'visible') {
        this.suspend()
        return
      }
      this.resumeIfSuspended()
      this.wake()
    }
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const queueManager = new QueueManager()
