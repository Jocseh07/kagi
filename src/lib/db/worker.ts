/**
 * SQLite worker.
 *
 * VFS: `opfs-sahpool`, deliberately *not* the default `opfs` VFS. The default
 * one needs SharedArrayBuffer, which needs COOP:same-origin + COEP:require-corp,
 * and under require-corp every cross-origin <img> lacking a CORP header is
 * blocked — which is exactly how this app loads manga pages. `opfs-sahpool`
 * needs no cross-origin isolation. Its cost is that only one tab may hold the
 * pool at a time; that case is reported as the `MULTI_TAB` error code.
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import type { Database, SAHPoolUtil, SqlValue } from '@sqlite.org/sqlite-wasm'

export type DbErrorCode =
  | 'MULTI_TAB'
  | 'UNSUPPORTED'
  | 'INIT_FAILED'
  | 'NOT_READY'
  | 'SQL_ERROR'

export interface ExecResult {
  rows: SqlValue[][]
  columns: string[]
}

export interface InitResult {
  vfsName: string
  filename: string
}

export interface DbResultMap {
  init: InitResult
  exec: ExecResult
  export: Uint8Array
  import: null
  close: null
  wipe: null
  release: null
}

export type DbRequestType = keyof DbResultMap

export type WorkerRequest =
  | { id: number; type: 'init' }
  | { id: number; type: 'exec'; sql: string; params: readonly SqlValue[] }
  | { id: number; type: 'export' }
  | { id: number; type: 'import'; bytes: Uint8Array }
  | { id: number; type: 'close' }
  | { id: number; type: 'wipe' }
  | { id: number; type: 'release' }

export type WorkerResponse =
  | { id: number; ok: true; result: DbResultMap[DbRequestType] }
  | { id: number; ok: false; error: { code: DbErrorCode; message: string } }

interface WorkerScope {
  postMessage(message: WorkerResponse): void
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<WorkerRequest>) => void,
  ): void
}

const ctx = globalThis as unknown as WorkerScope

const DB_FILENAME = '/library.db'

class WorkerError extends Error {
  readonly code: DbErrorCode
  constructor(code: DbErrorCode, message: string) {
    super(message)
    this.name = 'WorkerError'
    this.code = code
  }
}

let poolUtil: SAHPoolUtil | undefined
let db: Database | undefined
let initPromise: Promise<InitResult> | undefined

/** Not in lib.dom for this TS version; probed structurally. */
interface SyncAccessCapableHandle {
  createSyncAccessHandle?: unknown
}

function hasSyncAccessHandles(): boolean {
  if (typeof navigator === 'undefined') return false
  if (typeof navigator.storage?.getDirectory !== 'function') return false
  if (!('FileSystemFileHandle' in globalThis)) return false
  const proto = FileSystemFileHandle.prototype as SyncAccessCapableHandle
  return typeof proto.createSyncAccessHandle === 'function'
}

/**
 * The pool fails to acquire its sync access handles when another tab already
 * holds them; the underlying failure is a NoModificationAllowedError, sometimes
 * re-thrown wrapped by the sqlite3 layer, so match on the message too.
 */
const MULTI_TAB_PATTERN =
  /NoModificationAllowedError|no modification allowed|createSyncAccessHandle|access handle/i

function classifyInitError(err: unknown): WorkerError {
  const name = err instanceof Error ? err.name : ''
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof WorkerError) return err
  if (name === 'NoModificationAllowedError' || MULTI_TAB_PATTERN.test(message)) {
    return new WorkerError(
      'MULTI_TAB',
      'The library database is already open in another tab.',
    )
  }
  if (/Missing required OPFS APIs|not (available|supported)/i.test(message)) {
    return new WorkerError('UNSUPPORTED', message)
  }
  return new WorkerError('INIT_FAILED', message)
}

async function init(): Promise<InitResult> {
  // A tab that handed the pool to another tab keeps its `poolUtil`, paused.
  // Re-acquiring the access handles is enough; no re-install, no reload.
  if (poolUtil?.isPaused()) {
    const util = await poolUtil.unpauseVfs()
    poolUtil = util
    db = new util.OpfsSAHPoolDb(DB_FILENAME)
    db.exec('PRAGMA foreign_keys = ON;')
    return { vfsName: util.vfsName, filename: DB_FILENAME }
  }

  if (!hasSyncAccessHandles()) {
    throw new WorkerError(
      'UNSUPPORTED',
      'This browser does not expose OPFS synchronous access handles.',
    )
  }

  const sqlite3 = await sqlite3InitModule()
  const util = await sqlite3.installOpfsSAHPoolVfs({ initialCapacity: 6 })
  poolUtil = util
  db = new util.OpfsSAHPoolDb(DB_FILENAME)
  db.exec('PRAGMA foreign_keys = ON;')
  return { vfsName: util.vfsName, filename: DB_FILENAME }
}

function ensureInit(): Promise<InitResult> {
  initPromise ??= init().catch((err: unknown) => {
    initPromise = undefined
    throw classifyInitError(err)
  })
  return initPromise
}

function requireDb(): Database {
  if (!db) throw new WorkerError('NOT_READY', 'Database is not open.')
  return db
}

function exec(sql: string, params: readonly SqlValue[]): ExecResult {
  const rows: SqlValue[][] = []
  const columns: string[] = []
  try {
    requireDb().exec(sql, {
      bind: params.length > 0 ? params : undefined,
      rowMode: 'array',
      resultRows: rows,
      columnNames: columns,
    })
  } catch (err) {
    if (err instanceof WorkerError) throw err
    throw new WorkerError(
      'SQL_ERROR',
      err instanceof Error ? err.message : String(err),
    )
  }
  return { rows, columns }
}

async function exportDb(): Promise<Uint8Array> {
  if (!poolUtil) throw new WorkerError('NOT_READY', 'Database is not open.')
  return await poolUtil.exportFile(DB_FILENAME)
}

async function importDb(bytes: Uint8Array): Promise<null> {
  const util = poolUtil
  if (!util) throw new WorkerError('NOT_READY', 'Database is not open.')
  db?.close()
  db = undefined
  await util.importDb(DB_FILENAME, bytes)
  db = new util.OpfsSAHPoolDb(DB_FILENAME)
  db.exec('PRAGMA foreign_keys = ON;')
  return null
}

function closeDb(): null {
  db?.close()
  db = undefined
  return null
}

/**
 * Empties the database, leaving a fresh file the caller can migrate.
 *
 * `wipeFiles()` is undefined behaviour while a handle is in use, so the
 * database is closed first. The request queue below guarantees no statement
 * interleaves with this.
 */
async function wipeDb(): Promise<null> {
  const util = poolUtil
  if (!util) throw new WorkerError('NOT_READY', 'Database is not open.')
  db?.close()
  db = undefined
  await util.wipeFiles()
  db = new util.OpfsSAHPoolDb(DB_FILENAME)
  db.exec('PRAGMA foreign_keys = ON;')
  return null
}

/**
 * Hands the OPFS pool to another tab.
 *
 * `pauseVfs()` requires the database to be closed first, and needs the cached
 * init to be dropped so the next `init` takes the unpause path above.
 */
function releaseDb(): null {
  db?.close()
  db = undefined
  poolUtil?.pauseVfs()
  initPromise = undefined
  return null
}

async function handle(
  request: WorkerRequest,
): Promise<DbResultMap[DbRequestType]> {
  if (request.type === 'init') return await ensureInit()
  // Releasing must never re-open what it is about to close.
  if (request.type === 'release') return releaseDb()
  await ensureInit()
  switch (request.type) {
    case 'exec':
      return exec(request.sql, request.params)
    case 'export':
      return await exportDb()
    case 'import':
      return await importDb(request.bytes)
    case 'close':
      return closeDb()
    case 'wipe':
      return await wipeDb()
  }
}

function toError(err: unknown): { code: DbErrorCode; message: string } {
  if (err instanceof WorkerError) return { code: err.code, message: err.message }
  const wrapped = classifyInitError(err)
  return { code: wrapped.code, message: wrapped.message }
}

// Requests are chained so that an async export/import can never interleave with
// the BEGIN/COMMIT pairs the query layer sends.
let queue: Promise<void> = Promise.resolve()

ctx.addEventListener('message', (event) => {
  const request = event.data
  queue = queue.then(async () => {
    try {
      const result = await handle(request)
      ctx.postMessage({ id: request.id, ok: true, result })
    } catch (err) {
      ctx.postMessage({ id: request.id, ok: false, error: toError(err) })
    }
  })
})
