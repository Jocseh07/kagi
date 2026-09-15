/**
 * Runs the real Mihon importer against a real backup and a real schema.
 *
 * The app's database lives in a web worker, so this installs a stand-in for it
 * backed by `node:sqlite` and speaking the same message protocol. Everything
 * above that — the embedded migrations, drizzle, `transact`, and every
 * statement in `mihon-import.ts` — is the shipping code, unmodified. The
 * conflict clause that keeps an import from walking progress backwards is not
 * something to take on faith.
 *
 *   pnpm exec tsx scripts/mihon-import-check.ts ~/Downloads/<file>.tachibk
 */

import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

installWorkerStandIn()

const { openDatabase, exec } = await import('../src/lib/db/migrate').then(
  async (migrate) => ({
    openDatabase: migrate.openDatabase,
    exec: (await import('../src/lib/db/client')).exec,
  }),
)
const { parseMihonBackup } = await import('../src/lib/backup/mihon')
const { planFromBackup } = await import('../src/lib/backup/mihon-plan')
const { runMihonImport } = await import('../src/lib/backup/mihon-import')

const path = process.argv[2]
if (!path) {
  console.error('usage: mihon-import-check.ts <file.tachibk>')
  process.exit(1)
}

let failures = 0

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(46)} ${String(actual)}${ok ? '' : ` (expected ${String(expected)})`}`,
  )
}

async function count(sql: string): Promise<number> {
  const { rows } = await exec(sql)
  return Number(rows[0]?.[0] ?? 0)
}

await openDatabase()

const backup = await parseMihonBackup(new Uint8Array(readFileSync(path)))
const plan = planFromBackup(backup)

const expectedSeries = plan.sources.reduce((n, s) => n + s.series, 0)
const expectedFavorites = plan.sources.reduce((n, s) => n + s.favorites, 0)
const expectedChapters = plan.sources.reduce((n, s) => n + s.chapters, 0)
const expectedRead = plan.sources.reduce((n, s) => n + s.readChapters, 0)
const expectedHistory = plan.entries.reduce((n, e) => n + e.history.size, 0)

console.log('\nfirst import')
const first = await runMihonImport(plan)
check('series added', first.seriesAdded, expectedSeries)
check('series merged', first.seriesMerged, 0)
check('chapters added', first.chaptersAdded, expectedChapters)
check('manga rows', await count('SELECT count(*) FROM manga'), expectedSeries)
check(
  'favourites',
  await count('SELECT count(*) FROM manga WHERE favorite = 1'),
  expectedFavorites,
)
check('chapter rows', await count('SELECT count(*) FROM chapters'), expectedChapters)
check(
  'read chapters',
  await count('SELECT count(*) FROM chapters WHERE read = 1'),
  expectedRead,
)
check('history rows', await count('SELECT count(*) FROM history'), expectedHistory)
check(
  'no chapter orphaned from its series',
  await count(
    'SELECT count(*) FROM chapters c LEFT JOIN manga m ON m.id = c.manga_id WHERE m.id IS NULL',
  ),
  0,
)
check(
  'sources written',
  (await exec('SELECT DISTINCT source_id FROM manga ORDER BY source_id')).rows
    .map((row) => row[0])
    .join(','),
  'asurascans,thunderscans',
)

console.log('\nre-import of the same file is a no-op')
const second = await runMihonImport(planFromBackup(backup))
check('series added', second.seriesAdded, 0)
check('series merged', second.seriesMerged, expectedSeries)
check('chapters added', second.chaptersAdded, 0)
check('chapters advanced', second.chaptersAdvanced, 0)
check('history entries touched', second.historyEntries, 0)
check('chapter rows unchanged', await count('SELECT count(*) FROM chapters'), expectedChapters)
check('history rows unchanged', await count('SELECT count(*) FROM history'), expectedHistory)

console.log('\nlocal progress ahead of the backup survives')
// A chapter the backup has as unread, read locally and taken to page 42.
const [ahead] = (
  await exec(
    'SELECT id, manga_id FROM chapters WHERE read = 0 AND last_page_read = 0 LIMIT 1',
  )
).rows
const aheadId = String(ahead![0])
await exec(
  'UPDATE chapters SET read = 1, last_page_read = 42, bookmarked = 1 WHERE id = ?',
  [aheadId],
)
await runMihonImport(planFromBackup(backup))
const [afterAhead] = (
  await exec(
    'SELECT read, last_page_read, bookmarked FROM chapters WHERE id = ?',
    [aheadId],
  )
).rows
check('still read', Number(afterAhead![0]), 1)
check('page position kept', Number(afterAhead![1]), 42)
check('bookmark kept', Number(afterAhead![2]), 1)

console.log('\na deliberate un-read is not undone by an import')
// A chapter the backup has as read, reset locally the way the reader's own
// "mark unread" does — `progress_reset_at` is what makes it deliberate.
const [reset] = (
  await exec('SELECT id FROM chapters WHERE read = 1 LIMIT 1')
).rows
const resetId = String(reset![0])
await exec(
  'UPDATE chapters SET read = 0, last_page_read = 0, progress_reset_at = ? WHERE id = ?',
  [Date.now(), resetId],
)
await runMihonImport(planFromBackup(backup))
const [afterReset] = (
  await exec('SELECT read, last_page_read FROM chapters WHERE id = ?', [resetId])
).rows
check('still unread', Number(afterReset![0]), 0)
check('still at page zero', Number(afterReset![1]), 0)

console.log('\nlocal chapters the backup never mentions are left alone')
const [host] = (await exec('SELECT id FROM manga LIMIT 1')).rows
await exec(
  `INSERT INTO chapters (id, updated_at, device_id, manga_id, url, name, chapter_number, read, last_page_read, bookmarked, downloaded, page_count, progress_reset_at, verified)
   VALUES ('local-only', 1, 'test', ?, '/series/whatever/chapter/local-only', 'Local only', 9999, 1, 7, 0, 0, 0, 0, 1)`,
  [String(host![0])],
)
await runMihonImport(planFromBackup(backup))
const [survivor] = (
  await exec(
    "SELECT read, last_page_read FROM chapters WHERE id = 'local-only'",
  )
).rows
check('untouched', `${survivor![0]}/${survivor![1]}`, '1/7')

console.log(
  `\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`,
)
process.exit(failures === 0 ? 0 : 1)

// ------------------------------------------------------- the worker stand-in --

/**
 * A `Worker` that is really `node:sqlite`, speaking `src/lib/db/worker.ts`'s
 * message protocol. Only the requests this script provokes are implemented.
 */
function installWorkerStandIn(): void {
  const database = new DatabaseSync(':memory:')

  class NodeWorker {
    private listeners = new Map<string, ((event: unknown) => void)[]>()

    addEventListener(type: string, handler: (event: unknown) => void): void {
      const list = this.listeners.get(type)
      if (list) list.push(handler)
      else this.listeners.set(type, [handler])
    }

    postMessage(request: {
      id: number
      type: string
      sql?: string
      params?: unknown[]
    }): void {
      queueMicrotask(() => {
        try {
          this.reply({ id: request.id, ok: true, result: this.run(request) })
        } catch (error) {
          this.reply({
            id: request.id,
            ok: false,
            error: {
              code: 'SQL_ERROR',
              message: error instanceof Error ? error.message : String(error),
            },
          })
        }
      })
    }

    private run(request: { type: string; sql?: string; params?: unknown[] }) {
      if (request.type === 'init') {
        return { vfsName: 'node:sqlite', filename: ':memory:' }
      }
      if (request.type !== 'exec') return null

      const sql = request.sql ?? ''
      const params = (request.params ?? []).map((value) =>
        typeof value === 'boolean' ? (value ? 1 : 0) : value,
      ) as never[]

      const statement = database.prepare(sql)
      // `all()` covers both cases: a statement with no result set answers with
      // an empty array rather than refusing.
      const rows = statement.all(...params) as Record<string, unknown>[]
      return {
        rows: rows.map((row) => Object.values(row)),
        columns: rows[0] ? Object.keys(rows[0]) : [],
      }
    }

    private reply(message: unknown): void {
      for (const handler of this.listeners.get('message') ?? []) {
        handler({ data: message })
      }
    }
  }

  Object.assign(globalThis, {
    Worker: NodeWorker,
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
    },
  })
}
