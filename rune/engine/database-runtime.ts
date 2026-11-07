import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { configureDatabase, databasePath, initDb, exec, nativeDatabase } from './adapters/database'
import { nativeSchema } from './adapters/adapt-store'
import { LATEST_SCHEMA_VERSION, runMigrations } from '@/lib/db/migrate'

const LIBRARY_MIGRATIONS = [
  'Create library, chapters, categories, memberships, history, preferences, settings, and initial indexes.',
  'Add saved chapter page lists, saved timestamps, and page counts.',
  'Create persistent download queue and queue indexes.',
  'Add measured saved-byte accounting.',
  'Add novel chapter text storage and series content kind.',
  'Add historical dirty flags and progress-reset timestamps; replace obsolete oplog bookkeeping.',
  'Add saved-image verification state.',
  'Add chapter scanlation groups.',
  'Create fact ledger and pending index; remove obsolete tombstones and old sync cursor.',
  'Remove unused dirty-flag columns and indexes.',
  'Rewrite legacy Flame Comics chapter URLs and dependent fact and queue addresses.',
  'Canonicalize legacy series, chapter, queue, and fact URLs.',
] as const

export interface DatabaseStatus {
  path: string
  exists: boolean
  libraryVersion: number
  nativeVersion: number
  ready: boolean
  pending: { name: string; description: string }[]
  nativeSql: string[]
  error?: string
}

const NATIVE_VERSION = 1
let root = ''
let initializing: Promise<void> | undefined

export function configureRuntimeDatabase(directory: string): void {
  root = resolve(directory)
  configureDatabase(root)
}

export function runtimeRoot(): string {
  if (!root) throw new Error('The native data directory is not configured.')
  return root
}

export function databaseStatus(): DatabaseStatus {
  if (LIBRARY_MIGRATIONS.length !== LATEST_SCHEMA_VERSION) throw new Error('The native migration descriptions need updating before database initialization.')
  const path = databasePath()
  let libraryVersion = 0
  let nativeVersion = 0
  let error: string | undefined
  const exists = existsSync(path)
  if (exists) {
    let database: Database | undefined
    try {
      database = new Database(path, { readonly: true, create: false })
      const tables = new Set(database.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((entry) => entry.name))
      if (tables.has('schema_version')) libraryVersion = Number(database.query<{ version: number | null }, []>('SELECT MAX(version) AS version FROM schema_version').get()?.version ?? 0)
      if (tables.has('native_runtime_meta')) nativeVersion = Number(database.query<{ version: number | null }, []>('SELECT MAX(version) AS version FROM native_runtime_meta').get()?.version ?? 0)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'The local database could not be inspected.'
    } finally {
      database?.close()
    }
  }
  const pending: DatabaseStatus['pending'] = LIBRARY_MIGRATIONS.flatMap((description, index) => index + 1 > libraryVersion ? [{ name: `V${index + 1}`, description }] : [])
  const nativeSql = nativeVersion < NATIVE_VERSION ? [
    ...nativeSchema(),
    'CREATE TABLE IF NOT EXISTS native_runtime_meta (version INTEGER PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL)',
  ] : []
  if (nativeSql.length) pending.push({ name: `native-runtime-${NATIVE_VERSION}`, description: 'Create native adaptation, file, and runtime metadata tables.' })
  return {
    path, exists, libraryVersion, nativeVersion,
    ready: !error && libraryVersion === LATEST_SCHEMA_VERSION && nativeVersion === NATIVE_VERSION,
    pending, nativeSql, ...(error ? { error } : {}),
  }
}

export async function initializeRuntimeDatabase(): Promise<void> {
  if (initializing) return initializing
  initializing = (async () => {
    const status = databaseStatus()
    if (status.error) throw new Error('The database is unreadable. Restore a valid backup before initializing it.')
    if (status.libraryVersion > LATEST_SCHEMA_VERSION || status.nativeVersion > NATIVE_VERSION) throw new Error('This library needs a newer Kagi version. Its database was not changed.')
    await initDb()
    await runMigrations()
    const statements = nativeSchema()
    await exec('BEGIN IMMEDIATE')
    try {
      for (const statement of statements) await exec(statement)
      await exec('CREATE TABLE IF NOT EXISTS native_runtime_meta (version INTEGER PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL)')
      await exec('INSERT OR IGNORE INTO native_runtime_meta (version, created_at) VALUES (?, ?)', [NATIVE_VERSION, Date.now()])
      await exec('COMMIT')
    } catch (error) {
      await exec('ROLLBACK')
      throw error
    }
    nativeDatabase().query('PRAGMA foreign_keys = ON').run()
  })().finally(() => { initializing = undefined })
  return initializing
}

export function defaultDataRoot(): string {
  const base = process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? '', '.local/share')
  if (!base) throw new Error('Set XDG_DATA_HOME or HOME before opening the app.')
  return join(base, 'kagi-rune')
}
