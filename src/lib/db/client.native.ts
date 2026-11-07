import { drizzle } from 'drizzle-orm/sqlite-proxy'
import * as SQLite from 'expo-sqlite'
import { ulid } from 'ulid'
import { schema } from './schema'

export type SqlValue = string | number | null | bigint | Uint8Array
export type DbErrorCode = 'MULTI_TAB' | 'UNSUPPORTED' | 'INIT_FAILED' | 'NOT_READY' | 'SQL_ERROR'

export interface ExecResult {
  rows: SqlValue[][]
  columns: string[]
}

export interface InitResult {
  vfsName: string
  filename: string
}

export class DbError extends Error {
  readonly code: DbErrorCode
  constructor(code: DbErrorCode, message: string) {
    super(message)
    this.name = 'DbError'
    this.code = code
  }
}

const FILENAME = 'kagi.db'

let activeStatements = 0
const idleListeners = new Set<() => void>()

export async function waitForDatabaseIdle(): Promise<void> {
  await txChain
  if (activeStatements === 0) return
  await new Promise<void>((resolve) => idleListeners.add(resolve))
}

let handle: SQLite.SQLiteDatabase | null = null
let opening: Promise<SQLite.SQLiteDatabase> | null = null

function open(): Promise<SQLite.SQLiteDatabase> {
  if (handle) return Promise.resolve(handle)
  opening ??= SQLite.openDatabaseAsync(FILENAME)
    .then(async (database) => {
      await database.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
      handle = database
      return database
    })
    .catch((cause: unknown) => {
      opening = null
      throw new DbError('INIT_FAILED', cause instanceof Error ? cause.message : String(cause))
    })
  return opening
}

/** Opens the database. Safe to call repeatedly. */
export async function initDb(): Promise<InitResult> {
  await open()
  return { vfsName: 'expo-sqlite', filename: FILENAME }
}

// expo-sqlite has no bigint or blob binding through the raw path; both are passed as their closest kind.
function bindable(value: SqlValue): string | number | null | Uint8Array {
  return typeof value === 'bigint' ? Number(value) : value
}

export async function exec(sql: string, params: readonly SqlValue[] = []): Promise<ExecResult> {
  activeStatements++
  let statement: SQLite.SQLiteStatement | null = null
  try {
    const database = await open()
    statement = await database.prepareAsync(sql)
    const result = await statement.executeForRawResultAsync(params.map(bindable))
    const rows = (await result.getAllAsync()) as SqlValue[][]
    const columns = await statement.getColumnNamesAsync()
    return { rows, columns }
  } catch (cause) {
    if (cause instanceof DbError) throw cause
    throw new DbError('SQL_ERROR', cause instanceof Error ? cause.message : String(cause))
  } finally {
    await statement?.finalizeAsync().catch(() => undefined)
    activeStatements--
    if (activeStatements === 0) { for (const listener of idleListeners) listener(); idleListeners.clear() }
  }
}

/** Raw database bytes, for backup export. */
export async function exportDatabase(): Promise<Uint8Array> {
  const database = await open()
  return database.serializeAsync()
}

/** Replaces the database with `bytes`. Every cached query result is now stale. */
export async function importDatabase(bytes: Uint8Array): Promise<null> {
  const source = await SQLite.deserializeDatabaseAsync(bytes)
  await closeDatabase()
  await SQLite.deleteDatabaseAsync(FILENAME)
  const target = await SQLite.openDatabaseAsync(FILENAME)
  await SQLite.backupDatabaseAsync({ sourceDatabase: source, destDatabase: target })
  await source.closeAsync()
  await target.closeAsync()
  return null
}

export async function closeDatabase(): Promise<null> {
  const database = handle
  handle = null
  opening = null
  await database?.closeAsync()
  return null
}

/** A phone has one process per app, so there is nothing to hand over; closing is enough. */
export function releaseDatabase(): Promise<null> {
  return closeDatabase()
}

/** Empties the database file. The caller must run migrations before touching it again. */
export async function wipeDatabase(): Promise<null> {
  await closeDatabase()
  await SQLite.deleteDatabaseAsync(FILENAME)
  return null
}

export const db = drizzle(
  async (sql, params, method) => {
    const { rows } = await exec(sql, params as SqlValue[])
    if (method === 'get') return { rows: rows[0] ?? [] }
    if (method === 'run') return { rows: [] }
    return { rows }
  },
  { schema },
)

export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

let txChain: Promise<unknown> = Promise.resolve()

export function transact<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
  const run = txChain.then(() => db.transaction((tx) => fn(tx)))
  txChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

const DEVICE_ID_KEY = 'kagi.device-id'
let cachedDeviceId: string | undefined

/** Stable per install; stamped onto every row for later merge. */
export function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId
  const stored = globalThis.localStorage?.getItem(DEVICE_ID_KEY) ?? null
  if (stored) {
    cachedDeviceId = stored
    return stored
  }
  const created = ulid()
  globalThis.localStorage?.setItem(DEVICE_ID_KEY, created)
  cachedDeviceId = created
  return created
}
