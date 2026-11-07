import { openDB } from 'idb'
import type { DBSchema, IDBPDatabase } from 'idb'
import type { GenerationRecord, JournalArtifact, JournalBundle, JournalEvent, JournalStore } from './types'
import { readBundle, upgradeRecord, upgradeEvents } from './helpers'

interface JournalDb extends DBSchema {
  runs: { key: string; value: GenerationRecord; indexes: { input: string; schema: number; adaptation: string; status: string } }
  events: { key: string; value: JournalEvent; indexes: { generation: string; requestCopy: string } }
  artifacts: { key: string; value: JournalArtifact; indexes: { generation: string } }
}

export type JournalWrite =
  | { kind: 'run'; run: GenerationRecord }
  | { kind: 'event'; event: JournalEvent }
  | { kind: 'artifact'; artifact: JournalArtifact }

const listeners = new Set<(write?: JournalWrite) => void>()
const writeListeners = new Set<(write: JournalWrite) => void>()
let version = 0
let database: Promise<IDBPDatabase<JournalDb>> | undefined
/** Inputs a running capture refers to before its first record is saved, so a deletion keeps them. */
const heldInputs = new Map<string, number>()

function changed(write?: JournalWrite) {
  version++
  if (write) for (const listener of writeListeners) listener(write)
  for (const listener of listeners) listener(write)
}

/** `write` is the stored record, or absent for a change that is not one record, such as a deletion. */
export function subscribeJournal(listener: (write?: JournalWrite) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Each record the local journal actually stored, as it is stored. */
export function onJournalWrite(listener: (write: JournalWrite) => void): () => void {
  writeListeners.add(listener)
  return () => writeListeners.delete(listener)
}

export function getJournalVersion(): number {
  return version
}

function db() {
  if (typeof indexedDB === 'undefined') throw new Error('Generation storage is unavailable in this environment.')
  database ??= openDB<JournalDb>('kagi-generation-journal', 3, {
    upgrade(store, oldVersion, _newVersion, transaction) {
      if (oldVersion < 1) {
        store.createObjectStore('runs', { keyPath: 'id' })
        store.createObjectStore('events', { keyPath: 'id' }).createIndex('generation', 'generationId')
        store.createObjectStore('artifacts', { keyPath: 'id' }).createIndex('generation', 'generationId')
      }
      if (oldVersion < 2) {
        const runs = transaction.objectStore('runs')
        runs.createIndex('input', 'inputs', { multiEntry: true })
        runs.createIndex('schema', 'schemaVersion')
      }
      if (oldVersion < 3) {
        // Only version 1 request events carry `data`, a copy of the request, so this index lists exactly what is left to migrate.
        transaction.objectStore('events').createIndex('requestCopy', 'data.path')
        // An adaptation's page and the startup recovery read their runs by these, so neither grows with the whole journal.
        transaction.objectStore('runs').createIndex('adaptation', 'target.adaptationId')
        transaction.objectStore('runs').createIndex('status', 'status')
      }
    },
    blocking() {
      void database?.then((connection) => connection.close())
      database = undefined
    },
    terminated() { database = undefined },
  }).then(async (connection) => {
    await migrateRuns(connection).then(() => dropRequestCopies(connection)).catch((error: unknown) => {
      console.error('Generation journal migration stopped. Unmigrated records stay readable and are retried on the next start.', error)
    })
    return connection
  })
  return database
}

/** Hashing cannot run inside the upgrade transaction, so each version 1 run moves in its own transaction after it, with its events. */
async function migrateRuns(connection: IDBPDatabase<JournalDb>): Promise<void> {
  for (const id of await connection.getAllKeysFromIndex('runs', 'schema', 1)) {
    const run = await connection.get('runs', id)
    if (!run || run.schemaVersion !== 1) continue
    const upgraded = await upgradeRecord(run)
    const tx = connection.transaction(['runs', 'events', 'artifacts'], 'readwrite')
    const current = await tx.objectStore('runs').get(id)
    if (current?.schemaVersion === 1 && current.updatedAt === run.updatedAt) {
      const artifacts = tx.objectStore('artifacts')
      for (const artifact of upgraded.artifacts) if (await artifacts.getKey(artifact.id) === undefined) await artifacts.put(artifact)
      const events = tx.objectStore('events')
      const stored = await events.index('generation').getAll(id)
      const kept = upgradeEvents(current, stored)
      for (const [index, event] of kept.entries()) if (event !== stored[index]) await events.put(event)
      await tx.objectStore('runs').put(upgraded.run)
    }
    await tx.done
  }
}

/** Runs an earlier build upgraded kept their events' request copies; each event is fixed in its own transaction. */
async function dropRequestCopies(connection: IDBPDatabase<JournalDb>): Promise<void> {
  for (const id of await connection.getAllKeysFromIndex('events', 'requestCopy')) {
    const tx = connection.transaction(['runs', 'events'], 'readwrite')
    const events = tx.objectStore('events')
    const event = await events.get(id)
    const run = event && await tx.objectStore('runs').get(event.generationId)
    const [kept] = event && run ? upgradeEvents(run, [event]) : []
    if (kept && kept !== event) await events.put(kept)
    await tx.done
  }
}

/** Keeps `ids` through any deletion until the returned release runs. */
export function holdInputs(ids: readonly string[]): () => void {
  for (const id of ids) heldInputs.set(id, (heldInputs.get(id) ?? 0) + 1)
  let held = true
  return () => {
    if (!held) return
    held = false
    for (const id of ids) {
      const left = (heldInputs.get(id) ?? 1) - 1
      if (left) heldInputs.set(id, left)
      else heldInputs.delete(id)
    }
  }
}

/** One adaptation's runs, newest first, read by index so the cost follows that adaptation, not the whole journal. */
export async function listAdaptationRuns(adaptationId: string): Promise<GenerationRecord[]> {
  return (await (await db()).getAllFromIndex('runs', 'adaptation', adaptationId)).sort((a, b) => b.createdAt - a.createdAt)
}


export const journalStore: JournalStore = {
  async putRun(run) {
    const tx = (await db()).transaction('runs', 'readwrite')
    const existing = await tx.store.get(run.id)
    if (existing && existing.updatedAt === run.updatedAt && JSON.stringify(existing) === JSON.stringify(run)) {
      await tx.done
      return
    }
    await tx.store.put(run)
    await tx.done
    changed({ kind: 'run', run })
  },
  async getRun(id) { return (await db()).get('runs', id) },
  async listRuns() {
    return (await (await db()).getAll('runs')).sort((a, b) => b.createdAt - a.createdAt)
  },
  async putEvent(event) {
    const connection = await db()
    const tx = connection.transaction('events', 'readwrite')
    const existing = await tx.store.get(event.id)
    if (existing && JSON.stringify(existing) !== JSON.stringify(event)) {
      tx.abort()
      throw new Error('A journal event with this ID already exists.')
    }
    if (existing) {
      await tx.done
      return
    }
    await tx.store.put(event)
    await tx.done
    changed({ kind: 'event', event })
  },
  async getEvents(id) {
    return (await (await db()).getAllFromIndex('events', 'generation', id)).sort((a, b) => a.sequence - b.sequence)
  },
  async putArtifact(artifact) {
    const connection = await db()
    const tx = connection.transaction('artifacts', 'readwrite')
    const existing = await tx.store.get(artifact.id)
    if (existing && (existing.sha256 !== artifact.sha256 || existing.generationId !== artifact.generationId ||
      existing.name !== artifact.name || existing.mime !== artifact.mime || existing.size !== artifact.size)) {
      tx.abort()
      throw new Error('A journal artifact with this ID already exists.')
    }
    if (existing) {
      await tx.done
      return
    }
    await tx.store.put(artifact)
    await tx.done
    changed({ kind: 'artifact', artifact })
  },
  async getArtifact(id) { return (await db()).get('artifacts', id) },
  async getArtifacts(id) { return (await db()).getAllFromIndex('artifacts', 'generation', id) },
  async deleteRun(id) {
    const tx = (await db()).transaction(['runs', 'events', 'artifacts'], 'readwrite')
    const runs = tx.objectStore('runs')
    const run = await runs.get(id)
    await runs.delete(id)
    for (const name of ['events', 'artifacts'] as const) {
      const store = tx.objectStore(name)
      for (const key of await store.index('generation').getAllKeys(id)) await store.delete(key)
    }
    for (const input of run?.inputs ?? []) {
      if (!heldInputs.has(input) && !await runs.index('input').count(input)) await tx.objectStore('artifacts').delete(input)
    }
    await tx.done
    changed()
  },
}

export async function getBundle(store: JournalStore, id: string): Promise<JournalBundle> {
  if (store === journalStore) {
    const tx = (await db()).transaction(['runs', 'events', 'artifacts'], 'readonly')
    const run = await tx.objectStore('runs').get(id)
    const events = await tx.objectStore('events').index('generation').getAll(id)
    const artifacts = await tx.objectStore('artifacts').index('generation').getAll(id)
    for (const input of run?.inputs ?? []) {
      const artifact = await tx.objectStore('artifacts').get(input)
      if (artifact) artifacts.push(artifact)
    }
    await tx.done
    if (!run) throw new Error('Generation not found.')
    return { run, events: events.sort((a, b) => a.sequence - b.sequence), artifacts }
  }
  return readBundle(store,id)
}

export async function recoverInterrupted(store: JournalStore): Promise<void> {
  const runs = store === journalStore ? await (await db()).getAllFromIndex('runs', 'status', 'running') : await store.listRuns()
  for (const run of runs) {
    if (run.status !== 'running') continue
    if (!run.ownerId.startsWith('browser:') && Date.now() - run.updatedAt <= 3_600_000) continue
    const mark = async () => {
      const current = await store.getRun(run.id)
      if (!current || current.status !== 'running') return
      const now = Date.now()
      const events = await store.getEvents(run.id)
      await store.putEvent({ id: crypto.randomUUID(), generationId: run.id, sequence: Math.max(-1, ...events.map((event) => event.sequence)) + 1, at: now, kind: 'interrupted', message: 'Generation stopped before its result was recorded.' })
      await store.putRun({ ...current, status: 'interrupted', error: 'Generation stopped before its result was recorded.', updatedAt: now, finishedAt: now })
    }
    if (typeof navigator !== 'undefined' && navigator.locks) {
      await navigator.locks.request(`kagi-generation:${run.id}`, { ifAvailable: true }, async (lock) => { if (lock) await mark() })
    } else if (Date.now() - run.updatedAt > 1_800_000) await mark()
  }
}
