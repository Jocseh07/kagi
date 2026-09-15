import { drizzle } from 'drizzle-orm/sqlite-proxy'
import { ulid } from 'ulid'
import type { SqlValue } from '@sqlite.org/sqlite-wasm'
import { schema } from './schema'
import type {
  DbErrorCode,
  DbResultMap,
  DbRequestType,
  ExecResult,
  InitResult,
  WorkerRequest,
  WorkerResponse,
} from './worker'

export type { DbErrorCode, ExecResult, InitResult }

export class DbError extends Error {
  readonly code: DbErrorCode
  constructor(code: DbErrorCode, message: string) {
    super(message)
    this.name = 'DbError'
    this.code = code
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

const pending = new Map<number, Pending>()
let worker: Worker | undefined
let nextId = 1

function rejectAll(error: DbError): void {
  for (const p of pending.values()) p.reject(error)
  pending.clear()
}

function getWorker(): Worker {
  if (worker) return worker
  if (typeof Worker === 'undefined') {
    throw new DbError('UNSUPPORTED', 'Web Workers are unavailable.')
  }
  const created = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'kagi-db',
  })
  created.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
    const message = event.data
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.ok) entry.resolve(message.result)
    else entry.reject(new DbError(message.error.code, message.error.message))
  })
  created.addEventListener('error', (event) => {
    rejectAll(new DbError('INIT_FAILED', event.message || 'Database worker crashed.'))
  })
  worker = created
  return created
}

function call<K extends DbRequestType>(
  request: Omit<Extract<WorkerRequest, { type: K }>, 'id'>,
): Promise<DbResultMap[K]> {
  const target = getWorker()
  const id = nextId++
  return new Promise<DbResultMap[K]>((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => {
        resolve(value as DbResultMap[K])
      },
      reject,
    })
    target.postMessage({ ...request, id } as WorkerRequest)
  })
}

/** Boots the worker and opens the database. Safe to call repeatedly. */
export function initDb(): Promise<InitResult> {
  return call<'init'>({ type: 'init' })
}

export function exec(
  sql: string,
  params: readonly SqlValue[] = [],
): Promise<ExecResult> {
  return call<'exec'>({ type: 'exec', sql, params })
}

/** Raw database bytes, for backup export. */
export function exportDatabase(): Promise<Uint8Array> {
  return call<'export'>({ type: 'export' })
}

/** Replaces the database with `bytes`. Every cached query result is now stale. */
export function importDatabase(bytes: Uint8Array): Promise<null> {
  return call<'import'>({ type: 'import', bytes })
}

export function closeDatabase(): Promise<null> {
  return call<'close'>({ type: 'close' })
}

/**
 * Gives up the OPFS pool so another tab can open the library. The data stays
 * on disk; a later `initDb()` re-acquires it.
 */
export function releaseDatabase(): Promise<null> {
  return call<'release'>({ type: 'release' })
}

/**
 * Empties the database file. The schema is gone with the rows, so the caller
 * must run migrations before touching it again.
 */
export function wipeDatabase(): Promise<null> {
  return call<'wipe'>({ type: 'wipe' })
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

// drizzle's proxy driver implements transactions by sending BEGIN/COMMIT as
// ordinary statements, so two overlapping transactions would interleave. Route
// every transaction through one chain.
let txChain: Promise<unknown> = Promise.resolve()

export function transact<T>(
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  const run = txChain.then(() => db.transaction((tx) => fn(tx)))
  txChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

const DEVICE_ID_KEY = 'kagi.device-id'
let cachedDeviceId: string | undefined

/** Stable per browser profile; stamped onto every row for later merge. */
export function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId
  let stored: string | null = null
  try {
    stored = globalThis.localStorage?.getItem(DEVICE_ID_KEY) ?? null
  } catch {
    stored = null
  }
  if (stored) {
    cachedDeviceId = stored
    return stored
  }
  const created = ulid()
  try {
    globalThis.localStorage?.setItem(DEVICE_ID_KEY, created)
  } catch {
    // Storage is blocked (private mode); the id stays process-local.
  }
  cachedDeviceId = created
  return created
}
