import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { projectQuotaCost } from '@/lib/offline/types'
import type { SavedChapterInfo } from '@/lib/offline/types'
import { contentKindOfId } from '@/lib/sources/catalog'
import { NOVEL_PROGRESS_SCALE } from '@/lib/text/progress'
import type { ChapterText, ContentKind, Page, SChapter, SManga } from '@/lib/sources/types'
import {
  HIDDEN,
  PRESENT,
  encodeLabel,
  isDeviceLocalSetting,
  seriesKey,
} from '@/lib/sync/fact-kinds'
import { applyFacts } from '@/lib/sync/project'
import { bumpChangeSignal } from './change-signal'
import { CHUNK_SIZE, chunk } from './chunk'
import { db, getDeviceId, transact } from './client'
import {
  assertFact,
  assertFacts,
  chapterFactsForSeries,
  chapterKeysOf,
  seriesKeysOf,
} from './facts'
import { touchHistory } from './history'
import {
  chapterPages,
  chapterText,
  chapters,
  manga,
  settings,
  sourcePrefs,
} from './schema'
import type { Chapter, Manga } from './schema'

/**
 * Local bookkeeping stamped onto every row: when it was last written here, and
 * by which device. Neither reaches the server. What leaves the device is the
 * `facts` ledger, and a fact carries no clock and no author — it is replaced by
 * a later generation of itself, never by a later timestamp.
 */
function stamp(): { updatedAt: number; deviceId: string } {
  return { updatedAt: Date.now(), deviceId: getDeviceId() }
}

// Re-exported for the callers that have always reached them through here.
export { CHUNK_SIZE, chunk }

function definedOnly<T extends object>(value: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry
  }
  return out as Partial<T>
}

// ------------------------------------------------------------------ manga --

/**
 * Whether a source id names a comic or a novel source.
 *
 * Read from the source catalog rather than passed in by callers: a row whose
 * `contentKind` disagreed with its source would open in the wrong reader, and
 * there are six call sites that would each have to remember. An id the catalog
 * does not know is treated as a comic — the same default the column carries.
 *
 * The catalog rather than the registry, because the registry constructs every
 * source to answer this, and two of them carry a ZIP decoder. `registry.ts`
 * checks the two agree.
 */
function contentKindOf(sourceId: string): ContentKind {
  return contentKindOfId(sourceId)
}

export async function upsertManga(
  sourceId: string,
  source: SManga,
): Promise<Manga> {
  const { updatedAt, deviceId } = stamp()
  const contentKind = contentKindOf(sourceId)
  // Source details are patched in; user state (favorite, dateAdded, lastRead)
  // is never clobbered by a refetch.
  const details = definedOnly({
    title: source.title,
    author: source.author,
    artist: source.artist,
    description: source.description,
    genres: source.genre,
    status: source.status,
    thumbnailUrl: source.thumbnailUrl,
    contentKind,
    memo: source.memo,
  })

  // Only a row whose source details actually moved is restamped. Every
  // download, favourite, and mark-read passes through here, and `updatedAt`
  // is what orders the library under "Last checked"; restamping an unchanged
  // series would bump it to the top for an action that checked nothing.
  // Built from the keys present in `details`: an omitted column arrives in
  // `excluded` as null, and "not sent" is not a change.
  const changedBySource = sql.join(
    Object.keys(details).map(
      (key) =>
        sql`${manga[key as keyof typeof details]} is not excluded.${sql.raw(
          manga[key as keyof typeof details].name,
        )}`,
    ),
    sql` or `,
  )

  let queued = 0
  const row = await transact(async (tx) => {
    const [saved] = await tx
      .insert(manga)
      .values({
        id: ulid(),
        updatedAt,
        deviceId,
        sourceId,
        url: source.url,
        title: source.title,
        status: source.status,
        ...details,
      })
      .onConflictDoUpdate({
        target: [manga.sourceId, manga.url],
        set: {
          ...details,
          updatedAt: sql`case when ${changedBySource} then ${updatedAt} else ${manga.updatedAt} end`,
          deviceId: sql`case when ${changedBySource} then ${deviceId} else ${manga.deviceId} end`,
        },
      })
      .returning()

    if (!saved) throw new Error(`upsertManga failed for ${sourceId}:${source.url}`)

    // Every caller of this is a reader doing something with the series:
    // favouriting it, opening a chapter, queueing a download. That makes it a
    // series they have met, which is what the fact records; `state` says
    // whether it is in the library, and `setFavorite` is what moves that.
    queued = await assertFact(tx, {
      kind: 'lib',
      key: seriesKey(sourceId, saved.url),
      state: saved.favorite ? PRESENT : HIDDEN,
      val: saved.favorite ? (saved.dateAdded ?? 0) : 0,
      payload: encodeLabel({ t: saved.title, c: saved.thumbnailUrl ?? undefined }),
    })
    return saved
  })
  // Only when something is genuinely waiting. Opening the reader on a series
  // already stated here writes nothing, and the panel must not claim otherwise.
  if (queued > 0) bumpChangeSignal(queued)
  return row
}

/**
 * Refreshes the source-owned columns of a series already on this device,
 * without queueing a sync push.
 *
 * The series page refetches details on every visit, and none of these columns
 * is a decision the reader made: they are the source's own copy of itself, and
 * every device fetches them for free. `updatedAt` and `deviceId` are left alone
 * for the same reason — they record *user* edits, and a background refresh is
 * not one.
 *
 * An UPDATE, never an INSERT. A series that is not stored is one the reader
 * has not asked to keep, and browsing past it must not fill the database.
 */
export async function cacheMangaDetails(
  sourceId: string,
  source: SManga,
): Promise<void> {
  const details = definedOnly({
    title: source.title,
    author: source.author,
    artist: source.artist,
    description: source.description,
    genres: source.genre,
    status: source.status,
    thumbnailUrl: source.thumbnailUrl,
    memo: source.memo,
  })
  if (Object.keys(details).length === 0) return

  await db
    .update(manga)
    .set(details)
    .where(and(eq(manga.sourceId, sourceId), eq(manga.url, source.url)))
}

export async function getManga(id: string): Promise<Manga | null> {
  const [row] = await db.select().from(manga).where(eq(manga.id, id)).limit(1)
  return row ?? null
}

export async function getMangaByUrl(
  sourceId: string,
  url: string,
): Promise<Manga | null> {
  const [row] = await db
    .select()
    .from(manga)
    .where(and(eq(manga.sourceId, sourceId), eq(manga.url, url)))
    .limit(1)
  return row ?? null
}

export async function setFavorite(
  mangaId: string,
  favorite: boolean,
): Promise<Manga | null> {
  const { updatedAt, deviceId } = stamp()
  const row = await transact(async (tx) => {
    const [existing] = await tx
      .select()
      .from(manga)
      .where(eq(manga.id, mangaId))
      .limit(1)
    if (!existing) return null

    const [saved] = await tx
      .update(manga)
      .set({
        favorite,
        dateAdded: favorite ? (existing.dateAdded ?? updatedAt) : existing.dateAdded,
        updatedAt,
        deviceId,
      })
      .where(eq(manga.id, mangaId))
      .returning()

    if (!saved) return null

    // `val` carries the date added while the series is kept, and drops to zero
    // when it is not. That is what settles two devices meeting at the same
    // generation: being in someone's library outranks merely having been seen.
    await assertFact(tx, {
      kind: 'lib',
      key: seriesKey(saved.sourceId, saved.url),
      state: favorite ? PRESENT : HIDDEN,
      val: favorite ? (saved.dateAdded ?? updatedAt) : 0,
      payload: encodeLabel({ t: saved.title, c: saved.thumbnailUrl ?? undefined }),
    })
    return saved
  })
  if (row) bumpChangeSignal()
  return row
}

export function listFavorites(): Promise<Manga[]> {
  return db
    .select()
    .from(manga)
    .where(eq(manga.favorite, true))
    .orderBy(asc(manga.title))
}

/**
 * The urls this source's favourited series are stored under.
 *
 * One read for a whole grid: a browse page draws dozens of covers at once and
 * asking `getMangaByUrl` per card would be a query per visible tile. Urls
 * rather than rows because membership is the only thing a card shows.
 */
export async function listFavoriteUrls(sourceId: string): Promise<string[]> {
  const rows = await db
    .select({ url: manga.url })
    .from(manga)
    .where(and(eq(manga.sourceId, sourceId), eq(manga.favorite, true)))
  return rows.map((row) => row.url)
}

// --------------------------------------------------------------- chapters --

/**
 * Records a source's chapter list.
 *
 * One multi-row upsert per chunk rather than a statement per chapter: each one
 * is a round trip to the database worker, and a long series made favouriting
 * visibly slow.
 *
 * Only the source's own fields are written on conflict. Read state — `read`,
 * `lastPageRead`, `bookmarked`, `downloaded`, `savedAt`, `pageCount`,
 * `savedBytes` — is never touched, so a refetch cannot mark a read chapter
 * unread. A list that omits
 * `dateUpload` leaves the stored one alone, matching the per-field patching the
 * row-by-row version did.
 */
export async function upsertChapters(
  mangaId: string,
  list: readonly SChapter[],
): Promise<Chapter[]> {
  if (list.length === 0) return []
  const { updatedAt, deviceId } = stamp()

  // Last entry wins when one list repeats a url, as it did when each chapter
  // was upserted in turn; a single statement cannot conflict with itself twice.
  const byUrl = new Map(list.map((chapter) => [chapter.url, chapter]))
  const unique = [...byUrl.values()]

  // What counts as a real change from the source's point of view. `dateUpload`
  // compares through coalesce twice because an omitted value keeps the stored
  // one and so is not a change.
  const changedBySource = sql`(
    ${chapters.name} != excluded.name
    or ${chapters.chapterNumber} != excluded.chapter_number
    or coalesce(excluded.date_upload, ${chapters.dateUpload}, -1) != coalesce(${chapters.dateUpload}, -1)
    or coalesce(excluded.scanlator, ${chapters.scanlator}, '') != coalesce(${chapters.scanlator}, '')
  )`

  const sorted = await transact(async (tx) => {
    const [before] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(chapters)
      .where(eq(chapters.mangaId, mangaId))

    const saved: Chapter[] = []
    for (const group of chunk(unique, CHUNK_SIZE)) {
      const rows = await tx
        .insert(chapters)
        .values(
          group.map((chapter) => ({
            id: ulid(),
            updatedAt,
            deviceId,
            mangaId,
            url: chapter.url,
            name: chapter.name,
            chapterNumber: chapter.chapterNumber,
            dateUpload: chapter.dateUpload ?? null,
            scanlator: chapter.scanlator ?? null,
          })),
        )
        .onConflictDoUpdate({
          target: [chapters.mangaId, chapters.url],
          set: {
            name: sql`excluded.name`,
            chapterNumber: sql`excluded.chapter_number`,
            dateUpload: sql`coalesce(excluded.date_upload, ${chapters.dateUpload})`,
            // Coalesced like the upload date: a source that stops attributing
            // a chapter has not moved it to "no group", it has just stopped
            // saying, and the stored answer is better than none.
            scanlator: sql`coalesce(excluded.scanlator, ${chapters.scanlator})`,
            // Only rows whose source data actually moved are restamped. A
            // chapter list is refetched on every visit to a series, and
            // touching an unchanged backlog would rewrite the table and both
            // its indexes for nothing.
            updatedAt: sql`case when ${changedBySource} then ${updatedAt} else ${chapters.updatedAt} end`,
            deviceId: sql`case when ${changedBySource} then ${deviceId} else ${chapters.deviceId} end`,
          },
        })
        .returning()
      saved.push(...rows)
    }

    // Facts outlive the rows they describe: a chapter marked read on another
    // device arrives long before this one has fetched that chapter list, and
    // the fact waits in the ledger until the row it needs exists. This is
    // where it stops waiting.
    //
    // Only when the list actually grew. A series page refetches its chapters on
    // every visit, and re-projecting a whole series for a list that has not
    // changed would be the most expensive thing on that screen.
    const [after] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(chapters)
      .where(eq(chapters.mangaId, mangaId))

    if (Number(after?.count ?? 0) > Number(before?.count ?? 0)) {
      const series = await seriesKeysOf(tx, [mangaId])
      const key = series.get(mangaId)?.key
      if (key) await applyFacts(tx, await chapterFactsForSeries(tx, key))
    }

    // RETURNING makes no promise about row order; callers index into this.
    const position = new Map(unique.map((chapter, index) => [chapter.url, index]))
    return saved.sort(
      (a, b) => (position.get(a.url) ?? 0) - (position.get(b.url) ?? 0),
    )
  })
  // No change signal: a chapter list is the source's, not the reader's, and
  // none of it leaves the device any more.
  return sorted
}

export function listChapters(mangaId: string): Promise<Chapter[]> {
  return db
    .select()
    .from(chapters)
    .where(eq(chapters.mangaId, mangaId))
    .orderBy(desc(chapters.chapterNumber))
}

/**
 * Just the urls, for callers that only need to know which chapters are already
 * stored.
 *
 * The database lives in a worker, so every row of a `select()` is structure
 * cloned across a `postMessage`. A library update asks this question once per
 * series and throws everything but the url away, which on a long-running series
 * is a thousand full rows copied to build a thousand strings.
 */
export async function listChapterUrls(mangaId: string): Promise<string[]> {
  const rows = await db
    .select({ url: chapters.url })
    .from(chapters)
    .where(eq(chapters.mangaId, mangaId))
  return rows.map((row) => row.url)
}

export async function markChapterRead(
  chapterId: string,
  read = true,
): Promise<Chapter | null> {
  const { updatedAt, deviceId } = stamp()
  const row = await transact(async (tx) => {
    const [existing] = await tx
      .select()
      .from(chapters)
      .where(eq(chapters.id, chapterId))
      .limit(1)
    if (!existing) return null

    const [saved] = await tx
      .update(chapters)
      .set({
        read,
        updatedAt,
        deviceId,
        // Local only, and kept for the Mihon import, whose forward-only merge
        // refuses to undo a deliberate un-read. Sync expresses the same thing
        // as a new generation of the position fact below.
        ...(read ? {} : { progressResetAt: updatedAt, lastPageRead: 0 }),
      })
      .where(eq(chapters.id, chapterId))
      .returning()

    const [key] = await chapterKeysOf(tx, [chapterId])
    if (key) {
      await assertFacts(tx, [
        { kind: 'read', key: key.key, state: read ? PRESENT : HIDDEN },
        // An un-read is the one move allowed to rewind progress on another
        // device. It is a new generation of the position, which is what beats
        // the furthest-wins rule that would otherwise keep the old page.
        ...(read ? [] : [{ kind: 'pos' as const, key: key.key, val: 0, bump: true }]),
      ])
    }

    if (read) {
      // Also bumps the series' `lastRead`.
      await touchHistory(tx, existing.mangaId, chapterId, { updatedAt, deviceId })
    }

    return saved ?? null
  })
  if (row) bumpChangeSignal()
  return row
}

/**
 * Bulk form of `markChapterRead`, for marking a backlog in one write.
 *
 * Deliberately writes no history rows, matching `markMangaRead` in `library.ts`:
 * a bulk mark is not reading, and a long backlog would bury the history page
 * under one entry per chapter. The series' `lastRead` bump is kept, since that
 * is what orders the library.
 */
export async function markChaptersRead(
  chapterIds: readonly string[],
  read = true,
): Promise<void> {
  const ids = [...new Set(chapterIds)]
  if (ids.length === 0) return
  const { updatedAt, deviceId } = stamp()

  await transact(async (tx) => {
    const touched: { id: string; mangaId: string }[] = []
    for (const group of chunk(ids, CHUNK_SIZE)) {
      const rows = await tx
        .update(chapters)
        .set({
          read,
          updatedAt,
          deviceId,
          ...(read ? {} : { progressResetAt: updatedAt, lastPageRead: 0 }),
        })
        .where(inArray(chapters.id, group))
        .returning({ id: chapters.id, mangaId: chapters.mangaId })
      touched.push(...rows)
    }
    if (touched.length === 0) return

    const keys = await chapterKeysOf(
      tx,
      touched.map((row) => row.id),
    )
    await assertFacts(
      tx,
      keys.flatMap((key) => [
        { kind: 'read' as const, key: key.key, state: read ? PRESENT : HIDDEN },
        ...(read ? [] : [{ kind: 'pos' as const, key: key.key, val: 0, bump: true }]),
      ]),
    )

    if (!read) return
    const mangaIds = [...new Set(touched.map((row) => row.mangaId))]
    for (const group of chunk(mangaIds, CHUNK_SIZE)) {
      await tx
        .update(manga)
        .set({ lastRead: updatedAt, updatedAt, deviceId })
        .where(inArray(manga.id, group))
    }
  })
  bumpChangeSignal(ids.length)
}

export async function setLastPageRead(
  chapterId: string,
  page: number,
): Promise<Chapter | null> {
  const { updatedAt, deviceId } = stamp()
  const row = await transact(async (tx) => {
    const [saved] = await tx
      .update(chapters)
      .set({ lastPageRead: page, updatedAt, deviceId })
      .where(eq(chapters.id, chapterId))
      .returning()
    if (!saved) return null

    // Reading is the highest-frequency write in the app, so this deliberately
    // does not bump the generation: the position moves within one, the further
    // value wins, and a page turn that goes backwards queues nothing at all.
    const [key] = await chapterKeysOf(tx, [chapterId])
    if (key) await assertFact(tx, { kind: 'pos', key: key.key, val: page })
    return saved
  })
  if (row) bumpChangeSignal()
  return row
}

/**
 * Records how long a chapter is.
 *
 * Otherwise only `saveChapterPages` writes this, so a chapter that was never
 * kept offline has no total to show progress against and reads as "page 13"
 * rather than "13 / 40". Callers write it from a resolved page list, and only
 * when it differs from the stored value: this is one write per chapter, not one
 * per opening.
 */
export async function setChapterPageCount(
  chapterId: string,
  count: number,
): Promise<Chapter | null> {
  const { updatedAt, deviceId } = stamp()
  const row = await transact(async (tx) => {
    const [saved] = await tx
      .update(chapters)
      .set({ pageCount: count, updatedAt, deviceId })
      .where(eq(chapters.id, chapterId))
      .returning()
    return saved ?? null
  })
  return row
}

// ----------------------------------------------------------- saved pages --

/**
 * Replaces the stored page list for a chapter. Page URLs are only available
 * from the network at read time, so an offline reader depends on this row set
 * to know which cached images belong to the chapter.
 */
export async function saveChapterPages(
  chapterId: string,
  pages: readonly Page[],
): Promise<void> {
  const { updatedAt, deviceId } = stamp()
  await transact(async (tx) => {
    await tx.delete(chapterPages).where(eq(chapterPages.chapterId, chapterId))

    if (pages.length > 0) {
      // One multi-row insert: each statement is a round trip to the database
      // worker, and a long chapter is noticeably slow inserted row by row.
      await tx.insert(chapterPages).values(
        pages.map((page) => ({
          id: ulid(),
          updatedAt,
          deviceId,
          chapterId,
          index: page.index,
          url: page.imageUrl,
          descramble: page.descramble ?? null,
        })),
      )
    }

    await tx
      .update(chapters)
      .set({ pageCount: pages.length, updatedAt, deviceId })
      .where(eq(chapters.id, chapterId))
  })
}

export async function getChapterPages(chapterId: string): Promise<Page[]> {
  const rows = await db
    .select({
      index: chapterPages.index,
      url: chapterPages.url,
      descramble: chapterPages.descramble,
    })
    .from(chapterPages)
    .where(eq(chapterPages.chapterId, chapterId))
    .orderBy(asc(chapterPages.index))

  return rows.map((row) => ({
    index: row.index,
    imageUrl: row.url,
    descramble: row.descramble ?? undefined,
  }))
}

// ------------------------------------------------------------ saved text --

/**
 * Stores a novel chapter's prose, replacing whatever was there.
 *
 * `pageCount` is set to the permille scale a novel's resume point is measured
 * on, so a saved chapter has a total to show progress against in the same way a
 * comic's page count does — see the `lastPageRead` comment in the schema.
 */
export async function saveChapterText(
  chapterId: string,
  text: ChapterText,
): Promise<void> {
  const { updatedAt, deviceId } = stamp()
  await transact(async (tx) => {
    await tx.delete(chapterText).where(eq(chapterText.chapterId, chapterId))
    await tx.insert(chapterText).values({
      id: ulid(),
      updatedAt,
      deviceId,
      chapterId,
      html: text.html,
      textLength: text.textLength,
      savedAt: updatedAt,
    })

    await tx
      .update(chapters)
      .set({ pageCount: NOVEL_PROGRESS_SCALE, updatedAt, deviceId })
      .where(eq(chapters.id, chapterId))
  })
}

export async function getChapterText(
  chapterId: string,
): Promise<ChapterText | null> {
  const [row] = await db
    .select({ html: chapterText.html, textLength: chapterText.textLength })
    .from(chapterText)
    .where(eq(chapterText.chapterId, chapterId))
    .limit(1)
  return row ?? null
}

/** Ids of this series' chapters that have prose stored, for the chapter list. */
export async function getSavedTextChapterIds(
  mangaId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: chapters.id })
    .from(chapters)
    .innerJoin(chapterText, eq(chapterText.chapterId, chapters.id))
    .where(eq(chapters.mangaId, mangaId))
  return rows.map((row) => row.id)
}

/**
 * @param verified False when the pages were cached but could not be proved to
 * decode yet, which is what a save finishing in a hidden document produces.
 */
export async function markChapterSaved(
  chapterId: string,
  saved: boolean,
  verified = true,
): Promise<Chapter | null> {
  const { updatedAt, deviceId } = stamp()
  // Download state is device-local, so the row is deliberately *not* marked
  // dirty: what this device has saved offline is not another device's business,
  // and pushing the whole chapter row for it would be pure write amplification.
  return await transact(async (tx) => {
    const [row] = await tx
      .update(chapters)
      .set({
        downloaded: saved,
        savedAt: saved ? updatedAt : null,
        verified: saved ? verified : true,
        updatedAt,
        deviceId,
      })
      .where(eq(chapters.id, chapterId))
      .returning()
    return row ?? null
  })
}

/**
 * Saved chapters whose pages have not been proved to decode.
 *
 * These are saves that completed while the document was hidden. The bytes are
 * cached and the rows are written; all that is outstanding is the check, which
 * `verifyPendingChapters` runs when the app is next visible.
 */
export async function listUnverifiedChapterIds(): Promise<string[]> {
  const rows = await db
    .select({ id: chapters.id })
    .from(chapters)
    .where(and(isNotNull(chapters.savedAt), eq(chapters.verified, false)))
    .orderBy(asc(chapters.savedAt))
  return rows.map((row) => row.id)
}

/** Clears the unverified mark once every page has been proved to decode. */
export async function markChapterVerified(chapterId: string): Promise<void> {
  const { updatedAt, deviceId } = stamp()
  await transact(async (tx) => {
    await tx
      .update(chapters)
      .set({ verified: true, updatedAt, deviceId })
      .where(eq(chapters.id, chapterId))
  })
}

/** Records the quota a save really consumed, once it has been measured. */
export async function setChapterSavedBytes(
  chapterId: string,
  bytes: number,
): Promise<void> {
  const { updatedAt, deviceId } = stamp()
  // Device-local, like `markChapterSaved`: quota accounting never syncs.
  await transact(async (tx) => {
    await tx
      .update(chapters)
      .set({ savedBytes: bytes, updatedAt, deviceId })
      .where(eq(chapters.id, chapterId))
  })
}

/** Oldest save first, so a caller enforcing a limit can evict from the front. */
export async function listSavedChapters(): Promise<SavedChapterInfo[]> {
  const rows = await db
    .select({
      chapterId: chapters.id,
      mangaId: chapters.mangaId,
      mangaTitle: manga.title,
      chapterName: chapters.name,
      pageCount: chapters.pageCount,
      savedAt: chapters.savedAt,
      read: chapters.read,
      savedBytes: chapters.savedBytes,
      contentKind: manga.contentKind,
    })
    .from(chapters)
    .innerJoin(manga, eq(manga.id, chapters.mangaId))
    .where(isNotNull(chapters.savedAt))
    .orderBy(asc(chapters.savedAt))

  return rows.map(({ savedBytes, contentKind, ...row }) => ({
    ...row,
    savedAt: row.savedAt ?? 0,
    contentKind,
    // A novel's `pageCount` is the permille progress scale, not a number of
    // images, so the opaque-image projection is meaningless for it — running it
    // anyway would bill a saved chapter at 1000 padded pages. Prose is measured
    // exactly instead, and its real length is always written at save time.
    projectedBytes:
      contentKind === 'novel' ? (savedBytes ?? 0) : projectQuotaCost(row.pageCount),
    measuredBytes: savedBytes ?? null,
  }))
}

/**
 * Database half of an unsave. The cached images are the caller's problem.
 *
 * Both stores are cleared without asking which kind the chapter is: only one of
 * them can hold anything, and a delete that matches nothing costs a statement.
 * Checking first would cost a read and leave the other kind stranded if the
 * series' `contentKind` ever changed under it.
 */
export async function deleteSavedChapterRows(chapterId: string): Promise<void> {
  const { updatedAt, deviceId } = stamp()
  await transact(async (tx) => {
    await tx.delete(chapterPages).where(eq(chapterPages.chapterId, chapterId))
    await tx.delete(chapterText).where(eq(chapterText.chapterId, chapterId))
    // Device-local like the rest of the download state; not marked dirty.
    await tx
      .update(chapters)
      .set({
        downloaded: false,
        savedAt: null,
        verified: true,
        pageCount: 0,
        updatedAt,
        deviceId,
      })
      .where(eq(chapters.id, chapterId))
  })
}

export async function getSavedChapterIds(mangaId: string): Promise<string[]> {
  const rows = await db
    .select({ id: chapters.id })
    .from(chapters)
    .where(and(eq(chapters.mangaId, mangaId), isNotNull(chapters.savedAt)))
  return rows.map((row) => row.id)
}

// ---------------------------------------------------------- source prefs --

export async function getSourcePrefs(
  sourceId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({ key: sourcePrefs.key, value: sourcePrefs.value })
    .from(sourcePrefs)
    .where(eq(sourcePrefs.sourceId, sourceId))
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

export async function setSourcePref(
  sourceId: string,
  key: string,
  value: string,
): Promise<void> {
  const { updatedAt, deviceId } = stamp()
  // Source preferences may hold credentials; they stay on the device.
  await transact(async (tx) => {
    await tx
      .insert(sourcePrefs)
      .values({ id: ulid(), updatedAt, deviceId, sourceId, key, value })
      .onConflictDoUpdate({
        target: [sourcePrefs.sourceId, sourcePrefs.key],
        set: { value, updatedAt, deviceId },
      })
  })
}

// ------------------------------------------------------------------ settings --

export async function getSetting(key: string): Promise<string | null> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1)
  return row?.value ?? null
}

/**
 * Many settings in one pass, for callers that know their keys up front.
 *
 * Keys absent from the table are absent from the map rather than mapped to
 * null, so `map.get(key) ?? fallback` reads the same as `getSetting` does.
 * Chunked because the key list is caller-sized and each key binds a parameter.
 */
export async function getSettings(
  keys: readonly string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  if (keys.length === 0) return found

  for (const group of chunk([...new Set(keys)], CHUNK_SIZE)) {
    const rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(inArray(settings.key, group))
    for (const row of rows) found.set(row.key, row.value)
  }
  return found
}

/**
 * A setting read as an opt-in flag: absent means off.
 *
 * Every caller of this is a feature the user has to switch on deliberately, so
 * an unwritten key and a failed read must both come back `false` rather than
 * turning something on by accident.
 */
export async function getFlag(key: string): Promise<boolean> {
  try {
    return (await getSetting(key)) === '1'
  } catch {
    return false
  }
}

export async function setFlag(key: string, value: boolean): Promise<void> {
  await setSetting(key, value ? '1' : '0')
}

export async function setSetting(key: string, value: string): Promise<void> {
  const { updatedAt, deviceId } = stamp()
  const synced = !isDeviceLocalSetting(key)
  const queued = await transact(async (tx) => {
    await tx
      .insert(settings)
      .values({ id: ulid(), updatedAt, deviceId, key, value })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt, deviceId },
      })

    if (!synced) return 0
    // A preference is a value, not a claim that can be reached further into, so
    // every real change is a new generation. Writing the same value back is not
    // a change and `assertFact` drops it.
    return await assertFact(tx, { kind: 'set', key, payload: value, bump: true })
  })
  if (queued > 0) bumpChangeSignal()
}
