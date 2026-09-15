/**
 * Drizzle schema.
 *
 * Shaped for multi-device merge: every row carries a client-generated ULID
 * primary key (never an autoincrement, which would collide across devices), a
 * `updatedAt` timestamp and the `deviceId` that last wrote it. None of these
 * tables syncs: what leaves the device is the `facts` ledger at the bottom of
 * this file, which states what the reader decided rather than mirroring rows.
 */

import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import type { QueueState } from '@/lib/download/queue-types'
import type { ContentKind, MangaStatus, Page } from '@/lib/sources/types'
import type { FactKind } from '@/lib/sync/fact-kinds'

/** Called per table so no column builder instance is shared between tables. */
const syncColumns = () => ({
  id: text('id').primaryKey(),
  updatedAt: integer('updated_at').notNull(),
  deviceId: text('device_id').notNull(),
})

export const manga = sqliteTable(
  'manga',
  {
    ...syncColumns(),
    sourceId: text('source_id').notNull(),
    url: text('url').notNull(),
    title: text('title').notNull(),
    author: text('author'),
    artist: text('artist'),
    description: text('description'),
    genres: text('genres', { mode: 'json' }).$type<string[]>(),
    status: text('status').$type<MangaStatus>().notNull().default('unknown'),
    thumbnailUrl: text('thumbnail_url'),
    /**
     * Whether this series is a comic or a novel, copied from its source at
     * insert time. Denormalised on purpose: the library grid and the updates
     * feed both need it per row, and neither has the source instance to hand.
     */
    contentKind: text('content_kind').$type<ContentKind>().notNull().default('comic'),
    favorite: integer('favorite', { mode: 'boolean' }).notNull().default(false),
    dateAdded: integer('date_added'),
    lastRead: integer('last_read'),
    memo: text('memo', { mode: 'json' }).$type<Record<string, unknown>>(),
  },
  (t) => [
    uniqueIndex('manga_source_url_unique').on(t.sourceId, t.url),
    index('manga_favorite_idx').on(t.favorite),
  ],
)

export const chapters = sqliteTable(
  'chapters',
  {
    ...syncColumns(),
    mangaId: text('manga_id')
      .notNull()
      .references(() => manga.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    name: text('name').notNull(),
    chapterNumber: real('chapter_number').notNull().default(-1),
    dateUpload: integer('date_upload'),
    /**
     * The scanlation group, as the source names it. Null both for a source
     * that does not attribute chapters and for rows stored before the column
     * existed; either way the group is simply not known here.
     */
    scanlator: text('scanlator'),
    read: integer('read', { mode: 'boolean' }).notNull().default(false),
    /**
     * Resume point. Its unit depends on the series' `content_kind`: a page
     * index for a comic, and a 0–1000 permille scroll position for a novel,
     * whose "pages" are not discrete. `pageCount` is the matching total, so the
     * ratio is meaningful either way and `useReadingProgress` needs no branch.
     */
    lastPageRead: integer('last_page_read').notNull().default(0),
    bookmarked: integer('bookmarked', { mode: 'boolean' })
      .notNull()
      .default(false),
    downloaded: integer('downloaded', { mode: 'boolean' })
      .notNull()
      .default(false),
    /** When the chapter's images were cached for offline reading. */
    savedAt: integer('saved_at'),
    pageCount: integer('page_count').notNull().default(0),
    /**
     * Quota the save actually consumed, measured across the cache writes. Null
     * when it could not be attributed, in which case callers fall back to
     * `projectQuotaCost`.
     */
    savedBytes: integer('saved_bytes'),
    /**
     * Whether every cached page of this chapter has been proved to decode.
     *
     * A save that finishes while the document is hidden cannot run that proof —
     * a hidden document does not rasterize images — so the chapter is kept as
     * unverified rather than thrown away, and checked on the next foreground.
     * Device-local like the rest of the download state; never synced.
     */
    verified: integer('verified', { mode: 'boolean' }).notNull().default(true),
    /**
     * When the user last *deliberately* moved progress backwards — marked the
     * chapter unread, or reset it. Sync merges `read` and `lastPageRead`
     * monotonically (progress never regresses just because a stale device
     * pushed late), and this stamp is the escape hatch: a reset newer than the
     * other side's stamp wins over the "keep the furthest" rule. 0 = never.
     */
    progressResetAt: integer('progress_reset_at').notNull().default(0),
  },
  (t) => [
    uniqueIndex('chapters_manga_url_unique').on(t.mangaId, t.url),
    index('chapters_manga_idx').on(t.mangaId),
  ],
)

/**
 * Page list of a saved chapter. Page URLs normally come from the network at
 * read time, so without this an offline reader has no way to name the images
 * the service worker has cached.
 */
export const chapterPages = sqliteTable(
  'chapter_pages',
  {
    ...syncColumns(),
    chapterId: text('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    index: integer('index').notNull(),
    url: text('url').notNull(),
    descramble: text('descramble', { mode: 'json' }).$type<
      NonNullable<Page['descramble']>
    >(),
  },
  (t) => [uniqueIndex('chapter_pages_unique').on(t.chapterId, t.index)],
)

/**
 * Prose of a saved novel chapter.
 *
 * The counterpart to `chapter_pages`, and much the simpler of the two: text
 * bytes are readable by JavaScript, so a saved chapter is stored outright
 * rather than being parked in an opaque Cache API entry. No service worker is
 * involved, and a chapter costs what it weighs instead of the ~7 MB an opaque
 * page image is padded to.
 */
export const chapterText = sqliteTable(
  'chapter_text',
  {
    ...syncColumns(),
    chapterId: text('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    /** Sanitised fragment, safe to insert into the DOM as-is. */
    html: text('html').notNull(),
    /** Plain-text length, for reading estimates and the saved-size figure. */
    textLength: integer('text_length').notNull().default(0),
    savedAt: integer('saved_at').notNull(),
  },
  (t) => [uniqueIndex('chapter_text_chapter_unique').on(t.chapterId)],
)

export const categories = sqliteTable('categories', {
  ...syncColumns(),
  name: text('name').notNull(),
  order: integer('order').notNull().default(0),
})

export const mangaCategory = sqliteTable(
  'manga_category',
  {
    ...syncColumns(),
    mangaId: text('manga_id')
      .notNull()
      .references(() => manga.id, { onDelete: 'cascade' }),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('manga_category_unique').on(t.mangaId, t.categoryId),
    index('manga_category_category_idx').on(t.categoryId),
  ],
)

export const history = sqliteTable(
  'history',
  {
    ...syncColumns(),
    mangaId: text('manga_id')
      .notNull()
      .references(() => manga.id, { onDelete: 'cascade' }),
    chapterId: text('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    readAt: integer('read_at').notNull(),
  },
  (t) => [index('history_read_at_idx').on(t.readAt)],
)

export const sourcePrefs = sqliteTable(
  'source_prefs',
  {
    ...syncColumns(),
    sourceId: text('source_id').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
  },
  (t) => [uniqueIndex('source_prefs_unique').on(t.sourceId, t.key)],
)

export const settings = sqliteTable(
  'settings',
  {
    ...syncColumns(),
    key: text('key').notNull(),
    value: text('value').notNull(),
  },
  (t) => [uniqueIndex('settings_key_unique').on(t.key)],
)

/**
 * Chapters waiting to be saved offline. Persisted rather than held in memory so
 * an interrupted run resumes after a reload.
 *
 * Only `chapterId` carries a foreign key; deleting a manga still reaches these
 * rows because the cascade runs through `chapters`.
 */
export const downloadQueue = sqliteTable(
  'download_queue',
  {
    ...syncColumns(),
    chapterId: text('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    mangaId: text('manga_id').notNull(),
    sourceId: text('source_id').notNull(),
    mangaTitle: text('manga_title').notNull(),
    chapterName: text('chapter_name').notNull(),
    chapterUrl: text('chapter_url').notNull(),
    state: text('state').$type<QueueState>().notNull().default('queued'),
    position: integer('position').notNull(),
    pagesCompleted: integer('pages_completed').notNull().default(0),
    pagesTotal: integer('pages_total').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    queuedAt: integer('queued_at').notNull(),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
  },
  (t) => [
    uniqueIndex('download_queue_chapter_unique').on(t.chapterId),
    index('download_queue_state_position_idx').on(t.state, t.position),
  ],
)

/**
 * The sync ledger: one row per decision the reader has made.
 *
 * Everything above is a projection of a source's data and this table. The
 * tables hold what the app draws; this holds what is *true of the reader*, in
 * a form that can be stated to another device without either of them having to
 * agree on row ids first.
 *
 * Kept separate from the tables it describes for three reasons:
 *
 *  1. A fact outlives the row. A chapter marked read on another device arrives
 *     before this device has ever fetched that chapter list. The fact is
 *     stored anyway and applied the moment the chapter appears, which is why
 *     nothing has to be dropped as an orphan.
 *  2. One flag, one table. `acked` replaced a dirty flag on six tables and a
 *     tombstone table with a single pending set.
 *  3. A fact is immutable between generations, so an acknowledgement needs no
 *     guard against edits in flight beyond comparing what was sent.
 *
 * `state` is the hide: nothing is ever deleted from this table, an override is
 * a later generation of the same fact saying something else.
 */
export const facts = sqliteTable(
  'facts',
  {
    kind: text('kind').$type<FactKind>().notNull(),
    key: text('key').notNull(),
    /** Bumped when the reader overrides what they said before. */
    gen: integer('gen').notNull().default(0),
    /** The furthest-wins value within a generation: page, timestamp, order. */
    val: integer('val').notNull().default(0),
    state: integer('state').notNull().default(1),
    /** Display label, or the value itself for a setting. */
    payload: text('payload'),
    /** Cleared on every write, set once the server has the fact. */
    acked: integer('acked', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.key] }),
    index('facts_pending_idx')
      .on(t.acked)
      .where(sql`acked = 0`),
  ],
)

export const schema = {
  manga,
  chapters,
  chapterPages,
  chapterText,
  categories,
  mangaCategory,
  history,
  sourcePrefs,
  settings,
  downloadQueue,
  facts,
}

export type Manga = typeof manga.$inferSelect
export type NewManga = typeof manga.$inferInsert
export type Chapter = typeof chapters.$inferSelect
export type NewChapter = typeof chapters.$inferInsert
export type ChapterPage = typeof chapterPages.$inferSelect
export type NewChapterPage = typeof chapterPages.$inferInsert
export type ChapterTextRow = typeof chapterText.$inferSelect
export type Category = typeof categories.$inferSelect
export type HistoryEntry = typeof history.$inferSelect
export type SourcePref = typeof sourcePrefs.$inferSelect
export type Setting = typeof settings.$inferSelect
export type DownloadQueueRow = typeof downloadQueue.$inferSelect
export type NewDownloadQueueRow = typeof downloadQueue.$inferInsert
export type Fact = typeof facts.$inferSelect
