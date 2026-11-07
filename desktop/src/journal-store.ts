import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { assertGenerationRecord, upgradeEvents } from '../../src/lib/adapt/journal/helpers'
import type { GenerationRecord, JournalArtifact, JournalEvent, JournalStore } from '../../src/lib/adapt/journal/types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function checked(id: string): string {
  if (!UUID.test(id)) throw new Error('Invalid generation or artifact ID')
  return id
}
function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path,constants.O_RDONLY | constants.O_DIRECTORY)
  try { await directory.sync() } finally { await directory.close() }
}

export interface FileJournalStore extends JournalStore {
  replaceMigratedEvents(run: GenerationRecord, before: JournalEvent[], next: JournalEvent[]): Promise<void>
}

export interface FileJournalOptions {
  readOnly?: boolean
  isInputHeld?: (id: string) => boolean
  lock?: <T>(id: string, action: () => Promise<T>) => Promise<T>
}

export async function createFileJournal(directory: string, options: FileJournalOptions = {}): Promise<FileJournalStore> {
  const root = resolve(directory)
  const created = options.readOnly ? undefined : await mkdir(root, { recursive: true, mode: 0o700 })
  if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) throw new Error('Journal root cannot contain symbolic links')
  if (!options.readOnly) await chmod(root, 0o700)
  if (created) {
    const stop = resolve(created,'..')
    for (let current = root; ; current = resolve(current,'..')) { await syncDirectory(current); if (current === stop) break }
  }
  async function folder(id: string, child?: string, create = true): Promise<string> {
    const run = join(root, checked(id))
    for (const path of child ? [run, join(run, child)] : [run]) {
      let created = false
      if (create) await mkdir(path, { mode: 0o700 }).then(() => { created = true }).catch((error: unknown) => {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error
      })
      const stat = await lstat(path)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe journal directory')
      if (create) await chmod(path, 0o700)
      if (created) await syncDirectory(resolve(path,'..'))
    }
    return child ? join(run, child) : run
  }
  async function read(path: string): Promise<string | undefined> {
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { return await file.readFile('utf8') } finally { await file.close() }
    } catch (error) { if (missing(error)) return undefined; throw error }
  }
  async function atomic(path: string, data: string | Uint8Array): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      await file.writeFile(data)
      await file.sync()
      await file.close()
      await rename(temporary, path)
      await syncDirectory(resolve(path,'..'))
    } catch (error) {
      await file.close().catch(() => undefined)
      await rm(temporary, { force: true })
      throw error
    }
  }
  async function locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (options.readOnly) throw new Error('This journal folder is read-only.')
    if (options.lock) return options.lock(checked(id),action)
    const lock = join(root, `${checked(id)}.lock`)
    const deadline = Date.now() + 10_000
    while (true) {
      let acquired = false
      try { await mkdir(lock, { mode: 0o700 }); acquired = true } catch (error) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error
      }
      if (acquired) {
        try {
          const claims = await readdir(root)
          if (!claims.some((name) => name.startsWith(`${id}.browser-`) && name.endsWith('.lock'))) break
        } catch (error) {
          await rm(lock, { recursive: true })
          throw error
        }
        await rm(lock, { recursive: true })
      }
      if (Date.now() >= deadline) throw new Error(`Journal ${id} is locked. Close writers before removing stale .lock directories.`)
      await setTimeout(25)
    }
    try { return await action() } finally { await rm(lock, { recursive: true }) }
  }
  async function ids(): Promise<string[]> {
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter((entry) => UUID.test(entry.name) && entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name)
  }
  async function getRun(id: string): Promise<GenerationRecord | undefined> {
    checked(id)
    try {
      const stat = await lstat(join(root, id))
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe generation directory')
    } catch (error) { if (missing(error)) return undefined; throw error }
    const text = await read(join(root, id, 'manifest.json'))
    if (!text) return undefined
    const run: unknown = JSON.parse(text)
    assertGenerationRecord(run)
    if (run.id !== id) throw new Error('Invalid journal manifest')
    return run
  }
  async function getEvents(id: string): Promise<JournalEvent[]> {
    try { await folder(id, undefined, false) } catch (error) { if (missing(error)) return []; throw error }
    const text = await read(join(root, checked(id), 'events.jsonl'))
    return text ? text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as JournalEvent).sort((a, b) => a.sequence - b.sequence) : []
  }
  async function readArtifactAt(path: string, generationId: string, id: string): Promise<JournalArtifact | undefined> {
    const text = await read(join(path,`${checked(id)}.json`))
    if (text === undefined) return undefined
    const metadata = JSON.parse(text) as Omit<JournalArtifact,'blob'>
    checked(metadata.id)
    if (metadata.id !== id || metadata.generationId !== generationId) throw new Error('Invalid artifact metadata')
    const file = await open(join(path,`${id}.bin`),constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes: Uint8Array<ArrayBuffer>
    try { bytes = new Uint8Array(await file.readFile()) } finally { await file.close() }
    if (bytes.byteLength !== metadata.size || createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw new Error(`Corrupt artifact: ${id}`)
    return {...metadata,blob:new Blob([bytes],{type:metadata.mime})}
  }
  async function findArtifact(generationId: string, id: string): Promise<JournalArtifact | undefined> {
    let path: string
    try { path = await folder(generationId,'artifacts',false) }
    catch (error) { if (missing(error)) return undefined; throw error }
    return readArtifactAt(path,generationId,id)
  }
  async function getArtifacts(id: string): Promise<JournalArtifact[]> {
    let path: string
    try { path = await folder(id, 'artifacts', false) } catch (error) { if (missing(error)) return []; throw error }
    const result: JournalArtifact[] = []
    for (const entry of await readdir(path)) {
      if (!entry.endsWith('.json') || !UUID.test(entry.slice(0, -5))) continue
      const artifact = await readArtifactAt(path,id,entry.slice(0,-5))
      if (!artifact) throw new Error('Artifact metadata is missing')
      result.push(artifact)
    }
    return result
  }
  const store: FileJournalStore = {
    async replaceMigratedEvents(run, before, next) {
      await locked(run.id, async () => {
        const current = await getRun(run.id)
        const events = await getEvents(run.id)
        if (!current || current.updatedAt !== run.updatedAt || JSON.stringify(events) !== JSON.stringify(before) ||
          JSON.stringify(upgradeEvents(run, before)) !== JSON.stringify(next)) throw new Error('Generation changed during migration')
        const path = await folder(run.id)
        for (const event of next) {
          if (event.kind === 'request') await atomic(join(await folder(run.id, 'requests'), `${checked(event.id)}.json`), JSON.stringify(event))
        }
        await atomic(join(path, 'events.jsonl'), next.map((event) => JSON.stringify(event)).join('\n') + '\n')
      })
    },
    getRun, getEvents, getArtifacts,
    async listRuns() {
      const keys = await ids()
      const runs: (GenerationRecord | undefined)[] = new Array(keys.length)
      let next = 0; let failed = false; let failure: unknown
      const lane = async () => {
        while (!failed) {
          const index = next++; if (index >= keys.length) return
          try { runs[index] = await getRun(keys[index]) }
          catch (error) { failure = error; failed = true }
        }
      }
      await Promise.all(Array.from({length:Math.min(8,keys.length)},lane))
      if (failed) throw failure
      return runs.filter((run): run is GenerationRecord => !!run).sort((a, b) => b.createdAt - a.createdAt)
    },
    async putRun(run) {
      assertGenerationRecord(run)
      await locked(run.id, async () => {
        const previous = await getRun(run.id)
        if (previous?.request && JSON.stringify(previous.request) !== JSON.stringify(run.request)) throw new Error('Cannot overwrite an immutable generation request')
        if (previous && previous.updatedAt > run.updatedAt) throw new Error('Cannot overwrite a newer generation')
        const path = await folder(run.id)
        await folder(run.id, 'requests')
        await folder(run.id, 'responses')
        await folder(run.id, 'artifacts')
        if (run.request) await atomic(join(path, 'requests', 'original.json'), JSON.stringify(run.request))
        await atomic(join(path, 'manifest.json'), JSON.stringify(run))
      })
    },
    async putEvent(event) {
      await locked(event.generationId, async () => {
        await folder(event.generationId)
        const events = await getEvents(event.generationId)
        const previous = events.find((item) => item.id === event.id || item.sequence === event.sequence)
        if (previous) {
          if (JSON.stringify(previous) !== JSON.stringify(event)) throw new Error('Conflicting journal event')
          return
        }
        events.push(event)
        events.sort((a, b) => a.sequence - b.sequence)
        const path = await folder(event.generationId)
        if (event.kind === 'request' || event.kind === 'response') {
          const child = event.kind === 'request' ? 'requests' : 'responses'
          await atomic(join(await folder(event.generationId, child), `${checked(event.id)}.json`), JSON.stringify(event))
        }
        await atomic(join(path, 'events.jsonl'), events.map((item) => JSON.stringify(item)).join('\n') + '\n')
      })
    },
    async putArtifact(artifact) {
      await locked(artifact.generationId, async () => {
        checked(artifact.id)
        const bytes = new Uint8Array(await artifact.blob.arrayBuffer())
        if (bytes.byteLength !== artifact.size || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('Artifact checksum mismatch')
        const path = await folder(artifact.generationId, 'artifacts')
        const existing = await read(join(path, `${artifact.id}.json`))
        const { blob: _blob, ...metadata } = artifact
        if (existing) {
          if (existing !== JSON.stringify(metadata)) throw new Error('Cannot overwrite an immutable artifact')
          return
        }
        await atomic(join(path, `${artifact.id}.bin`), bytes)
        await atomic(join(path, `${artifact.id}.json`), JSON.stringify(metadata))
      })
    },
    async getArtifact(id) {
      checked(id)
      const shared = await findArtifact(id,id)
      if (shared) return shared
      for (const runId of await ids()) {
        if (runId === id) continue
        const artifact = await findArtifact(runId,id)
        if (artifact) return artifact
      }
      return undefined
    },
    async deleteRun(id) {
      const run = await locked(id, async () => {
        const current = await getRun(id)
        if (!current && (options.isInputHeld?.(id) || (await store.listRuns()).some((other) => other.inputs?.includes(id)))) return undefined
        await rm(join(root,checked(id)),{recursive:true,force:true})
        await syncDirectory(root)
        return current
      })
      if (!run?.inputs?.length) return
      for (const input of run.inputs) await locked(input, async () => {
        if (options.isInputHeld?.(input) || (await store.listRuns()).some((other) => other.inputs?.includes(input))) return
        await rm(join(root, checked(input)),{recursive:true,force:true})
        await syncDirectory(root)
      })
    },
  }
  return store
}
