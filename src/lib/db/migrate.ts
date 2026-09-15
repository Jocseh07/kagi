/**
 * Idempotent embedded migrations. Each entry in MIGRATIONS is one version; its
 * statements run in a single transaction and the version is recorded in
 * `schema_version`. Append new versions, never edit applied ones.
 *
 * A version may also be a function returning its statements, for the cases
 * SQLite cannot express declaratively — notably `ADD COLUMN`, which has no
 * `IF NOT EXISTS` form and so has to be guarded by probing `PRAGMA table_info`.
 * Such a version may return statements with bound values as well as plain sql,
 * for the rewrites whose new value is computed in TypeScript rather than by the
 * database.
 */

import { exec, initDb } from './client'
import type { InitResult } from './client'
import {
  LEGACY_URL_SOURCE_IDS,
  currentChapterUrl,
  currentSeriesUrl,
} from './legacy-urls'
import { SEP, chapterKey, seriesKey } from '@/lib/sync/fact-kinds'

const SCHEMA_VERSION_DDL = `CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY NOT NULL,
  applied_at INTEGER NOT NULL
)`

const V1: string[] = [
  `CREATE TABLE IF NOT EXISTS manga (
    id TEXT PRIMARY KEY NOT NULL,
    updated_at INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT,
    artist TEXT,
    description TEXT,
    genres TEXT,
    status TEXT NOT NULL DEFAULT 'unknown',
    thumbnail_url TEXT,
    favorite INTEGER NOT NULL DEFAULT 0,
    date_added INTEGER,
    last_read INTEGER,
    memo TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS manga_source_url_unique ON manga (source_id, url)`,
  `CREATE INDEX IF NOT EXISTS manga_favorite_idx ON manga (favorite)`,

  `CREATE TABLE IF NOT EXISTS chapters (
    id TEXT PRIMARY KEY NOT NULL,
    updated_at INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    manga_id TEXT NOT NULL REFERENCES manga(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    name TEXT NOT NULL,
    chapter_number REAL NOT NULL DEFAULT -1,
    date_upload INTEGER,
    read INTEGER NOT NULL DEFAULT 0,
    last_page_read INTEGER NOT NULL DEFAULT 0,
    bookmarked INTEGER NOT NULL DEFAULT 0,
    downloaded INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS chapters_manga_url_unique ON chapters (manga_id, url)`,
  `CREATE INDEX IF NOT EXISTS chapters_manga_idx ON chapters (manga_id)`,

  `CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY NOT NULL,
    updated_at INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    name TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS manga_category (
    id TEXT PRIMARY KEY NOT NULL,
    updated_at INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    manga_id TEXT NOT NULL REFERENCES manga(id) ON DELETE CASCADE,
    category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS manga_category_unique ON manga_category (manga_id, category_id)`,
  `CREATE INDEX IF NOT EXISTS manga_category_category_idx ON manga_category (category_id)`,

  `CREATE TABLE IF NOT EXISTS history (
    id TEXT PRIMARY KEY NOT NULL,
    updated_at INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    manga_id TEXT NOT NULL REFERENCES manga(id) ON DELETE CASCADE,
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    read_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS history_read_at_idx ON history (read_at)`,

  `CREATE TABLE IF NOT EXISTS source_prefs (
    id TEXT PRIMARY KEY NOT NULL,
    updated_at INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS source_prefs_unique ON source_prefs (source_id, key)`,

  `CREATE TABLE IF NOT EXISTS settings (
    id TEXT PRIMARY KEY NOT NULL,
    updated_at INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS settings_key_unique ON settings (key)`,

  `CREATE TABLE IF NOT EXISTS oplog (
    id TEXT PRIMARY KEY NOT NULL,
    updated_at INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    "table" TEXT NOT NULL,
    row_id TEXT NOT NULL,
    op TEXT NOT NULL,
    payload TEXT,
    ts INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS oplog_ts_idx ON oplog (ts)`,
]

/** Column names currently on `table`, for guarding `ALTER TABLE ADD COLUMN`. */
async function columnsOf(table: string): Promise<Set<string>> {
  const { rows } = await exec(`PRAGMA table_info(${table})`)
  return new Set(rows.map((row) => String(row[1])))
}

const V2_CHAPTER_COLUMNS: Record<string, string> = {
  saved_at: `ALTER TABLE chapters ADD COLUMN saved_at INTEGER`,
  page_count: `ALTER TABLE chapters ADD COLUMN page_count INTEGER NOT NULL DEFAULT 0`,
}

/** Offline chapter saving: the persisted page list, plus its chapter columns. */
const V2 = async (): Promise<string[]> => {
  const existing = await columnsOf('chapters')
  return [
    `CREATE TABLE IF NOT EXISTS chapter_pages (
      id TEXT PRIMARY KEY NOT NULL,
      updated_at INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      "index" INTEGER NOT NULL,
      url TEXT NOT NULL,
      descramble TEXT
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS chapter_pages_unique ON chapter_pages (chapter_id, "index")`,
    ...Object.entries(V2_CHAPTER_COLUMNS)
      .filter(([column]) => !existing.has(column))
      .map(([, statement]) => statement),
  ]
}

/**
 * The persistent download queue. Purely additive — a new table and its indexes
 * — so it needs no `PRAGMA table_info` guard the way V2's `ADD COLUMN` did.
 */
const V3: string[] = [
  `CREATE TABLE IF NOT EXISTS download_queue (
    id TEXT PRIMARY KEY NOT NULL,
    updated_at INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    manga_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    manga_title TEXT NOT NULL,
    chapter_name TEXT NOT NULL,
    chapter_url TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued',
    "position" INTEGER NOT NULL,
    pages_completed INTEGER NOT NULL DEFAULT 0,
    pages_total INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    queued_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS download_queue_chapter_unique ON download_queue (chapter_id)`,
  `CREATE INDEX IF NOT EXISTS download_queue_state_position_idx ON download_queue (state, "position")`,
]

/**
 * Real quota cost of a save, measured from `navigator.storage.estimate()`
 * rather than projected from the page count. Null on rows saved before this
 * column existed, and on saves that ran alongside another and so could not be
 * attributed. Guarded like V2: `ADD COLUMN` is not idempotent.
 */
const V4 = async (): Promise<string[]> => {
  const existing = await columnsOf('chapters')
  if (existing.has('saved_bytes')) return []
  return [`ALTER TABLE chapters ADD COLUMN saved_bytes INTEGER`]
}

/**
 * Light novels: the saved prose of a chapter, and the flag that says whether a
 * series is a comic or a novel at all.
 *
 * `content_kind` defaults to `comic`, so every row written before novels
 * existed keeps reading exactly as it did. The `ADD COLUMN` is guarded like V2
 * and V4; the table is additive and needs no guard.
 */
const V5 = async (): Promise<string[]> => {
  const existing = await columnsOf('manga')
  return [
    `CREATE TABLE IF NOT EXISTS chapter_text (
      id TEXT PRIMARY KEY NOT NULL,
      updated_at INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      html TEXT NOT NULL,
      text_length INTEGER NOT NULL DEFAULT 0,
      saved_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS chapter_text_chapter_unique ON chapter_text (chapter_id)`,
    ...(existing.has('content_kind')
      ? []
      : [
          `ALTER TABLE manga ADD COLUMN content_kind TEXT NOT NULL DEFAULT 'comic'`,
        ]),
  ]
}

/**
 * Dirty-flag sync. Replaces the oplog with per-row `needs_sync` flags and a
 * small `tombstones` table for deletes, and adds `progress_reset_at` so a
 * deliberate "mark unread" can beat the monotonic progress merge.
 *
 * The backfill marks every existing row dirty. Installs that had an unpushed
 * oplog backlog lose that bookkeeping when the table is dropped, and a full
 * re-push is the one operation that is guaranteed to cover whatever it held —
 * the server upsert is idempotent, so the cost is writes, never corruption.
 * Device-local settings (`sync.*`) stay clean: they must never leave the
 * device. The old per-device oplog cursor is meaningless now and goes too.
 */
const V6 = async (): Promise<string[]> => {
  const dirtyTables = [
    'manga',
    'chapters',
    'categories',
    'manga_category',
    'history',
    'settings',
  ]

  const statements: string[] = []
  for (const table of dirtyTables) {
    const existing = await columnsOf(table)
    if (!existing.has('needs_sync')) {
      statements.push(
        `ALTER TABLE ${table} ADD COLUMN needs_sync INTEGER NOT NULL DEFAULT 0`,
      )
    }
  }

  const chapterColumns = await columnsOf('chapters')
  if (!chapterColumns.has('progress_reset_at')) {
    statements.push(
      `ALTER TABLE chapters ADD COLUMN progress_reset_at INTEGER NOT NULL DEFAULT 0`,
    )
  }

  statements.push(
    `CREATE TABLE IF NOT EXISTS tombstones (
      id TEXT PRIMARY KEY NOT NULL,
      "table" TEXT NOT NULL,
      row_id TEXT NOT NULL,
      deleted_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS tombstones_row_unique ON tombstones ("table", row_id)`,
    // Partial indexes: the dirty set is normally tiny next to the tables, and
    // both the pending count and the push read exactly this predicate.
    ...dirtyTables.map(
      (table) =>
        `CREATE INDEX IF NOT EXISTS ${table}_needs_sync_idx ON ${table} (needs_sync) WHERE needs_sync = 1`,
    ),
    ...dirtyTables
      .filter((table) => table !== 'settings')
      .map((table) => `UPDATE ${table} SET needs_sync = 1`),
    `UPDATE settings SET needs_sync = CASE WHEN key LIKE 'sync.%' THEN 0 ELSE 1 END`,
    `DELETE FROM settings WHERE key = 'sync.oplog_cursor'`,
    `DROP TABLE IF EXISTS oplog`,
  )

  return statements
}

/**
 * Whether a saved chapter's pages have been proved to decode.
 *
 * Verification loads each cached page into an `Image`, which a hidden document
 * refuses to do, so a save that lands while the app is in the background is now
 * kept as unverified and checked when the app is next visible. Existing rows
 * were verified at save time, hence the default of 1. Guarded like V2 and V4:
 * `ADD COLUMN` is not idempotent.
 */
const V7 = async (): Promise<string[]> => {
  const existing = await columnsOf('chapters')
  if (existing.has('verified')) return []
  return [`ALTER TABLE chapters ADD COLUMN verified INTEGER NOT NULL DEFAULT 1`]
}

/**
 * The scanlation group a chapter came from.
 *
 * An aggregator carries the same series from several groups, and until now
 * nothing outside the source's own chapter list remembered which one a stored
 * chapter belonged to — so history could name a chapter but not the
 * translation. Null on rows written before this column existed; they fill in
 * as each series is next opened. Guarded like V2, V4 and V7.
 */
const V8 = async (): Promise<string[]> => {
  const existing = await columnsOf('chapters')
  if (existing.has('scanlator')) return []
  return [`ALTER TABLE chapters ADD COLUMN scanlator TEXT`]
}

/**
 * The sync ledger.
 *
 * Sync stops mirroring rows and starts stating facts, so the bookkeeping moves
 * from six `needs_sync` columns plus a tombstone table to one pending set
 * here. The old columns are left alone: dropping a column rebuilds the table,
 * and nothing reads them any more.
 *
 * `tombstones` goes, because a delete is now a fact with `state = 0` rather
 * than the absence of a row. Anything still sitting in it described a delete
 * under the old protocol, which the re-seed covers: every device restates its
 * whole library once, and a row that is gone is simply never stated.
 *
 * The pull cursor is dropped with it. It held a per-table position in the old
 * protocol's sequence space, which the new one does not share.
 */
const V9: string[] = [
  `CREATE TABLE IF NOT EXISTS facts (
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    gen INTEGER NOT NULL DEFAULT 0,
    val INTEGER NOT NULL DEFAULT 0,
    state INTEGER NOT NULL DEFAULT 1,
    payload TEXT,
    acked INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, key)
  )`,
  `CREATE INDEX IF NOT EXISTS facts_pending_idx ON facts (acked) WHERE acked = 0`,
  `DELETE FROM settings WHERE key = 'sync.pull_cursor'`,
  `DROP TABLE IF EXISTS tombstones`,
]

/**
 * Drops the dirty flag V6 added.
 *
 * Nothing has read it since the ledger took over; every write of it is gone
 * from the code, and a column with `NOT NULL DEFAULT 0` that nobody names is
 * simply filled with a zero forever. This reclaims it.
 *
 * The index has to go first: SQLite refuses to drop a column that one refers
 * to, and V6 put a partial index on each of these. `DROP COLUMN` itself is a
 * single statement rather than the create-copy-drop-rename dance older SQLite
 * needed — 3.35 added it, and the bundled build is 3.53 — so foreign keys,
 * cascades and every other index survive untouched.
 *
 * Guarded by probing the table, like every other `ALTER TABLE` here: it is not
 * idempotent, and this runs on databases that may have been half migrated.
 */
const V10 = async (): Promise<string[]> => {
  const tables = [
    'manga',
    'chapters',
    'categories',
    'manga_category',
    'history',
    'settings',
  ]

  const statements: string[] = []
  for (const table of tables) {
    statements.push(`DROP INDEX IF EXISTS ${table}_needs_sync_idx`)
    const existing = await columnsOf(table)
    if (existing.has('needs_sync')) {
      statements.push(`ALTER TABLE ${table} DROP COLUMN needs_sync`)
    }
  }
  return statements
}

/**
 * Flame Comics chapter urls, onto the shape every other source uses.
 *
 * The source used to store a chapter as the site addresses it —
 * `/series/<id>/<token>` — while the rest of the app addresses one as
 * `/series/<slug>/chapter/<key>` and rebuilds it from route parameters alone.
 * The two disagreed, and the rebuilt url parsed back as the token `chapter`, so
 * every chapter 404'd. The source now writes the app's shape; this moves the
 * rows already on the device so that read marks, resume positions, history and
 * downloads follow their chapter instead of being stranded on a url nothing
 * looks up any more.
 *
 * Facts go first, because a fact's key is built from the chapter url and the
 * old key can only be reconstructed while that url is still the old one.
 * `hist`, `read` and `pos` are the three kinds addressed by chapter; the rest
 * are keyed by series or category and are untouched.
 *
 * The old shape is "exactly one segment after the series url", which is what
 * the paired GLOBs say and what makes this idempotent: a row already migrated
 * has two and is skipped. `UPDATE OR REPLACE` on the facts, and the twin guard
 * on the chapters, cover the one device that fetched a chapter list under the
 * fixed source before this ran — without them a duplicate key would fail the
 * transaction and take the whole database open with it.
 */
const V11: string[] = [
  `UPDATE OR REPLACE facts
    SET key = (
      SELECT m.source_id || char(31) || m.url || char(31)
          || m.url || '/chapter/' || substr(c.url, length(m.url) + 2)
      FROM chapters c
      JOIN manga m ON m.id = c.manga_id
      WHERE facts.key = m.source_id || char(31) || m.url || char(31) || c.url
    )
    WHERE kind IN ('hist', 'read', 'pos')
      AND EXISTS (
        SELECT 1
        FROM chapters c
        JOIN manga m ON m.id = c.manga_id
        WHERE m.source_id = 'flamecomics'
          AND c.url GLOB m.url || '/*'
          AND c.url NOT GLOB m.url || '/*/*'
          AND facts.key = m.source_id || char(31) || m.url || char(31) || c.url
      )`,
  `UPDATE chapters
    SET url = (
      SELECT m.url || '/chapter/' || substr(chapters.url, length(m.url) + 2)
      FROM manga m
      WHERE m.id = chapters.manga_id
    )
    WHERE EXISTS (
      SELECT 1
      FROM manga m
      WHERE m.id = chapters.manga_id
        AND m.source_id = 'flamecomics'
        AND chapters.url GLOB m.url || '/*'
        AND chapters.url NOT GLOB m.url || '/*/*'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM manga m
      JOIN chapters t ON t.manga_id = chapters.manga_id
      WHERE m.id = chapters.manga_id
        AND t.url = m.url || '/chapter/' || substr(chapters.url, length(m.url) + 2)
    )`,
  // Last, and a straight copy: the queue names a chapter it already points at
  // by id, so whatever the row now says is what it should carry.
  `UPDATE download_queue
    SET chapter_url = (
      SELECT c.url FROM chapters c WHERE c.id = download_queue.chapter_id
    )
    WHERE source_id = 'flamecomics'
      AND EXISTS (
        SELECT 1 FROM chapters c WHERE c.id = download_queue.chapter_id
      )`,
]

/**
 * Series and chapter urls left over from the shapes sources used to store.
 *
 * The app addresses every work as `/series/<slug>` and every chapter as
 * `/series/<slug>/chapter/<key>`, and rebuilds both from route parameters
 * alone. Seven sources used to store the site's own path instead, which a route
 * parameter cannot hold: the slug came back with its slashes and the series was
 * re-addressed as `/series//manga/<slug>`, a page on no site. The sources were
 * fixed; the rows they wrote were not, so they are moved here. V11 did the same
 * for the one Flame Comics case, which is why that source is not in the table.
 * See legacy-urls.ts for the shapes.
 *
 * `manga.url` and `chapters.url` are identities — V1's unique indexes, and the
 * sync ledger's keys — so a rewrite that would land on a url the source already
 * holds is skipped rather than forced. One stale row is a repair that did not
 * reach everything; a failed constraint would roll the migration back and take
 * the database open with it.
 *
 * Row ids are untouched, so history, categories, saved pages and the download
 * queue keep pointing at the same work.
 */
const V12 = async (): Promise<Statement[]> => {
  const scope = LEGACY_URL_SOURCE_IDS
  const slots = scope.map(() => '?').join(', ')

  const { rows: mangaRows } = await exec(
    `SELECT id, source_id, url FROM manga WHERE source_id IN (${slots})`,
    scope,
  )

  const statements: Statement[] = []
  /** Manga id to its source, and its url before and after the rewrite. */
  const series = new Map<
    string,
    { sourceId: string; legacyUrl: string; url: string }
  >()
  const takenSeriesUrls = new Set(
    mangaRows.map((row) => `${String(row[1])}${SEP}${String(row[2])}`),
  )

  for (const row of mangaRows) {
    const id = String(row[0])
    const sourceId = String(row[1])
    const legacyUrl = String(row[2])
    const next = currentSeriesUrl(sourceId, legacyUrl)
    const taken = next !== null && takenSeriesUrls.has(`${sourceId}${SEP}${next}`)
    const url = next !== null && !taken ? next : legacyUrl

    series.set(id, { sourceId, legacyUrl, url })
    if (url === legacyUrl) continue

    takenSeriesUrls.add(`${sourceId}${SEP}${url}`)
    statements.push({
      sql: `UPDATE manga SET url = ? WHERE id = ?`,
      params: [url, id],
    })
  }

  const { rows: chapterRows } = await exec(
    `SELECT c.id, c.manga_id, c.url FROM chapters c
       JOIN manga m ON m.id = c.manga_id
      WHERE m.source_id IN (${slots})`,
    scope,
  )

  const takenChapterUrls = new Set(
    chapterRows.map((row) => `${String(row[1])}${SEP}${String(row[2])}`),
  )

  for (const row of chapterRows) {
    const id = String(row[0])
    const mangaId = String(row[1])
    const legacyUrl = String(row[2])
    const parent = series.get(mangaId)
    if (!parent) continue

    const url = currentChapterUrl(
      parent.sourceId,
      parent.legacyUrl,
      parent.url,
      legacyUrl,
    )
    if (!url || takenChapterUrls.has(`${mangaId}${SEP}${url}`)) continue

    takenChapterUrls.add(`${mangaId}${SEP}${url}`)
    statements.push(
      { sql: `UPDATE chapters SET url = ? WHERE id = ?`, params: [url, id] },
      // The queue names its chapter by id as well, so the copy it keeps for
      // fetching has to move with the row.
      {
        sql: `UPDATE download_queue SET chapter_url = ? WHERE chapter_id = ?`,
        params: [url, id],
      },
    )
  }

  return [...statements, ...(await legacyFactKeys())]
}

/**
 * The same move over `facts`, whose keys carry the urls rather than row ids.
 *
 * Read from the keys rather than from the tables above, because a fact can name
 * a chapter this device never fetched — that is how a pull creates one — so the
 * ledger holds addresses `chapters` does not. Each rewritten fact is unacked:
 * the next push restates it under the key this build produces.
 *
 * `UPDATE OR REPLACE` because two old keys can fold into one new one where the
 * old shape distinguished what the new one does not. The row that survives is
 * the rewritten fact, which is the one describing a series this build can still
 * address.
 */
async function legacyFactKeys(): Promise<Statement[]> {
  const { rows } = await exec(`SELECT kind, key FROM facts`)
  const statements: Statement[] = []

  for (const row of rows) {
    const kind = String(row[0])
    const key = String(row[1])
    if (kind !== 'lib' && kind !== 'member' && !isChapterFact(kind)) continue

    // `member` folds a category in front of a series key. The rest are the
    // series key itself, with a chapter url after it for the chapter kinds.
    const parts = key.split(SEP)
    const category = kind === 'member' ? parts.shift() : undefined
    const [sourceId, mangaUrl, chapterUrl] = parts
    if (!sourceId || !mangaUrl) continue

    const url = currentSeriesUrl(sourceId, mangaUrl) ?? mangaUrl
    const moved =
      chapterUrl === undefined
        ? seriesKey(sourceId, url)
        : chapterKey(
            sourceId,
            url,
            currentChapterUrl(sourceId, mangaUrl, url, chapterUrl) ?? chapterUrl,
          )
    const next = category === undefined ? moved : `${category}${SEP}${moved}`
    if (next === key) continue

    statements.push({
      sql: `UPDATE OR REPLACE facts SET key = ?, acked = 0 WHERE kind = ? AND key = ?`,
      params: [next, kind, key],
    })
  }

  return statements
}

/** The fact kinds addressed by chapter rather than by series. */
function isChapterFact(kind: string): boolean {
  return kind === 'hist' || kind === 'read' || kind === 'pos'
}

/** A statement, with its bound values where they are not known statically. */
type Statement = string | { sql: string; params: readonly string[] }

type Migration = Statement[] | (() => Promise<Statement[]>)

const MIGRATIONS: Migration[] = [V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, V11, V12]

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length

export async function currentSchemaVersion(): Promise<number> {
  await exec(SCHEMA_VERSION_DDL)
  const { rows } = await exec('SELECT MAX(version) FROM schema_version')
  const value = rows[0]?.[0]
  return typeof value === 'number' ? value : Number(value ?? 0)
}

/** Applies every pending migration. Returns the resulting schema version. */
export async function runMigrations(): Promise<number> {
  let version = await currentSchemaVersion()
  for (let i = version; i < MIGRATIONS.length; i++) {
    const target = i + 1
    const entry = MIGRATIONS[i]
    if (!entry) continue
    // Probed outside the transaction: it only reads, and a rollback would
    // otherwise leave the probe's answer stale for the retry.
    const statements = typeof entry === 'function' ? await entry() : entry
    await exec('BEGIN')
    try {
      for (const statement of statements) {
        if (typeof statement === 'string') await exec(statement)
        else await exec(statement.sql, statement.params)
      }
      await exec('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)', [
        target,
        Date.now(),
      ])
      await exec('COMMIT')
    } catch (err) {
      await exec('ROLLBACK')
      throw err
    }
    version = target
  }
  return version
}

/** Opens the database and brings the schema up to date. */
export async function openDatabase(): Promise<InitResult & { version: number }> {
  const info = await initDb()
  const version = await runMigrations()
  return { ...info, version }
}
