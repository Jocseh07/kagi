import { Database } from 'bun:sqlite'
import type { SQLQueryBindings } from 'bun:sqlite'
import { AsyncLocalStorage } from 'node:async_hooks'
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import { ulid } from 'ulid'
import { schema } from '../../../src/lib/db/schema'
import type { SqlValue } from '@sqlite.org/sqlite-wasm'
import type { DbErrorCode, ExecResult, InitResult } from '../../../src/lib/db/worker'
import { awaitLocalImageReferences, waitForLocalImageIdle } from './local-files-urls'
export type { DbErrorCode, ExecResult, InitResult }
export class DbError extends Error {
  constructor(readonly code: DbErrorCode, message: string, cause?: unknown) { super(message,{cause}); this.name = 'DbError' }
}
let root: string | undefined
let connection: Database | undefined
let device: string | undefined
let chain: Promise<unknown> = Promise.resolve()
const context = new AsyncLocalStorage<{active:boolean}>()
interface TransactionScope { active: boolean; tx?: DbTransaction; failure?: DbError }
const transaction = new AsyncLocalStorage<TransactionScope>()
export function configureDatabase(directory: string): void {
  const next = resolve(directory)
  if (connection && root !== next) throw new Error('Close the database before changing its directory.')
  root = next
  device = undefined
}
export function dataRoot(): string {
  if (!root) throw new Error('configureDatabase(root) must run before native storage is used.')
  return root
}
export function databasePath(): string { return join(dataRoot(), 'library.sqlite') }
export function nativeDatabase(): Database {
  if (!connection) throw new DbError('NOT_READY', 'Call initDb() after storage approval before using the database.')
  return connection
}
export async function initDb(): Promise<InitResult> {
  if (!connection) {
    try {
      mkdirSync(dataRoot(), { recursive: true, mode: 0o700 })
      connection = new Database(databasePath(), { create: true, strict: true })
      connection.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000')
    } catch (error) {
      connection?.close(); connection = undefined
      throw new DbError('INIT_FAILED',error instanceof Error ? error.message : String(error),error)
    }
  }
  return { vfsName: 'native', filename: databasePath() }
}
export function exclusive<T>(action: () => Promise<T>): Promise<T> {
  if (context.getStore()?.active) return action()
  const result = chain.then(() => {
    const scope = {active:true}
    return context.run(scope,async () => { try { return await action() } finally { scope.active = false } })
  })
  chain = result.then(() => undefined, () => undefined)
  return result
}
export async function waitForDatabaseIdle(): Promise<void> {
  if (context.getStore()?.active) throw new Error('Cannot wait for the database from inside an active database operation.')
  for (;;) {
    const queued = chain
    await queued
    await waitForLocalImageIdle()
    if (chain === queued) return
  }
}
export function exec(sql: string, params: readonly SqlValue[] = []): Promise<ExecResult> {
  return exclusive(async () => {
    const scope = transaction.getStore()
    if (scope?.active && scope.failure) throw scope.failure
    try {
      const database = nativeDatabase()
      await awaitLocalImageReferences(params)
      const statement = database.prepare<unknown, SQLQueryBindings[]>(sql)
      try {
        const columns = statement.columnNames
        if (!columns.length) { statement.run(...params); return { rows: [], columns: [] } }
        return { rows: statement.values(...params) as SqlValue[][], columns }
      } finally { statement.finalize() }
    } catch (error) {
      const failure = error instanceof DbError ? error : new DbError('SQL_ERROR',error instanceof Error ? error.message : String(error),error)
      if (scope?.active && scope.tx && connection && !connection.inTransaction) scope.failure ??= failure
      throw failure
    }
  })
}
export const db = drizzle(async (sql, params, method) => {
  const { rows } = await exec(sql, params as SqlValue[])
  return { rows: method === 'get' ? rows[0] ?? [] : method === 'run' ? [] : rows }
}, { schema })
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
export function transact<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
  const current = transaction.getStore()
  if (current?.active && current.tx) return current.failure ? Promise.reject(current.failure) : fn(current.tx)
  return exclusive(async () => {
    const scope: TransactionScope = {active:true}
    try { return await transaction.run(scope,() => db.transaction((tx) => { scope.tx = tx; return fn(tx) })) }
    catch (error) { throw scope.failure ?? error }
    finally { scope.active = false }
  })
}
export function sqliteTransaction<T>(fn: () => Promise<T>): Promise<T> {
  return transact(() => fn())
}
function containsPrivateSetting(database: Database): boolean {
  return !!database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get() &&
    !!database.query('SELECT 1 FROM settings WHERE key = ? LIMIT 1').get('adapt.apiKey')
}
function removePrivateSetting(database: Database): void {
  if (!containsPrivateSetting(database)) return
  database.exec('PRAGMA secure_delete = ON')
  database.query('DELETE FROM settings WHERE key = ?').run('adapt.apiKey')
  database.exec('VACUUM')
}
export function exportDatabase(): Promise<Uint8Array> {
  return exclusive(async () => {
    const current = nativeDatabase()
    if (!containsPrivateSetting(current)) return current.serialize()
    const copy = Database.deserialize(current.serialize())
    try { removePrivateSetting(copy); return copy.serialize() } finally { copy.close() }
  })
}
export function closeDatabase(): Promise<null> {
  return exclusive(async () => { connection?.close(); connection = undefined; return null })
}
export function releaseDatabase(): Promise<null> { return closeDatabase() }
export function importDatabase(bytes: Uint8Array): Promise<null> {
  return exclusive(async () => {
    const check = Database.deserialize(bytes)
    let imported: Uint8Array
    try {
      const integrity = check.query('PRAGMA integrity_check').values()
      if (integrity.length !== 1 || integrity[0]?.[0] !== 'ok') throw new Error('Invalid SQLite backup.')
      removePrivateSetting(check)
      imported = check.serialize()
    } finally { check.close() }
    const temporary = `${databasePath()}.import-${crypto.randomUUID()}`
    try {
      writeFileSync(temporary, imported, { mode: 0o600, flag: 'wx' })
      const file = openSync(temporary,'r')
      try { fsyncSync(file) } finally { closeSync(file) }
      connection?.close(); connection = undefined
      renameSync(temporary, databasePath())
      for (const suffix of ['-wal', '-shm']) rmSync(databasePath() + suffix, { force: true })
      const directory = openSync(dataRoot(),'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    } finally { rmSync(temporary,{force:true}) }
    await initDb()
    return null
  })
}
export function wipeDatabase(): Promise<null> {
  return exclusive(async () => {
    connection?.close(); connection = undefined
    for (const suffix of ['', '-wal', '-shm']) rmSync(databasePath() + suffix, { force: true })
    await initDb()
    return null
  })
}
export function getDeviceId(): string {
  if (device) return device
  const path = join(dataRoot(), 'device-id')
  if (existsSync(path)) return device = readFileSync(path, 'utf8').trim()
  mkdirSync(dataRoot(), { recursive: true, mode: 0o700 })
  const id = ulid()
  const temporary = `${path}.${id}.tmp`
  try {
    writeFileSync(temporary, id, { flag: 'wx', mode: 0o600 })
    const file = openSync(temporary,'r')
    try { fsyncSync(file) } finally { closeSync(file) }
    linkSync(temporary,path)
    const directory = openSync(dataRoot(),'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
    device = id
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error
    device = readFileSync(path,'utf8').trim()
  }
  finally { rmSync(temporary,{force:true}) }
  return device
}
