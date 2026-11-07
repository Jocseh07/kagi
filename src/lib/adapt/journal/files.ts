import { BlobReader, BlobWriter, TextReader, ZipReader, ZipWriter } from '@zip.js/zip.js'
import { getDirectoryHandle, pickDirectory, supportsFileSystemAccess, verifyPermission } from '../../storage/handles'
import { getBundle, getJournalVersion, journalStore, listAdaptationRuns, onJournalWrite, recoverInterrupted } from './store'
import { adaptationRunIds, assertGenerationRecord, importBundle, isJournalId, validateBundle } from './helpers'
import type { JournalWrite } from './store'
import type { GenerationRecord, JournalArtifact, JournalBundle, JournalEvent, JournalStore } from './types'
import type { DesktopJournalBridge } from '../desktop-bridge'

export interface RecordingState {
  mode: 'desktop' | 'folder' | 'local'
  status: 'ready' | 'unset' | 'denied' | 'error' | 'syncing'
  location: string | null
  error?: string
}
let state: RecordingState = { mode: 'local', status: 'unset', location: null }
const listeners = new Set<() => void>()
const HANDLE_KEY = 'generation-journal'
const DELETIONS_KEY = 'kagi-generation-journal-deletions'
interface JournalMirror {
  listRuns(): Promise<GenerationRecord[]>
  read(id: string): Promise<JournalBundle>
  write(bundle: JournalBundle): Promise<void>
  putRun(run: GenerationRecord): Promise<void>
  putEvent(event: JournalEvent): Promise<void>
  putArtifact(artifact: JournalArtifact): Promise<void>
  deleteRun(id: string): Promise<void>
}
let mirror: JournalMirror | undefined
let initialization: Promise<void> | undefined
let watching = false
let queue: Promise<void> = Promise.resolve()
const deleted = new Set<string>()
/** Per-run chains, so a run's records reach disk in the order they were stored. */
const writing = new Map<string, Promise<void>>()
/** Runs whose live write failed; the next sync sends them whole. */
const dirty = new Set<string>()
/** Runs being copied in from disk, which must not be written back. */
const fromDisk = new Set<string>()

export function getRecordingState(): RecordingState { return state }
export function subscribeRecording(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
function update(next: RecordingState): void {
  state = next
  for (const listener of listeners) listener()
}
function failed(error: unknown): void {
  update({ ...state, status: error instanceof DOMException && error.name === 'NotAllowedError' ? 'denied' : 'error', error: error instanceof Error ? error.message : String(error) })
}
function directoryStore(root: FileSystemDirectoryHandle): JournalStore {
  const safe = (id: string) => {
    if (!isJournalId(id)) throw new Error('Invalid generation or artifact ID')
    return id
  }
  async function directory(id: string, child?: string, create = false): Promise<FileSystemDirectoryHandle> {
    const run = await root.getDirectoryHandle(safe(id), { create })
    return child ? run.getDirectoryHandle(child, { create }) : run
  }
  async function read(dir: FileSystemDirectoryHandle, name: string): Promise<string | undefined> {
    try { return await (await (await dir.getFileHandle(name)).getFile()).text() } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return undefined
      throw error
    }
  }
  async function write(dir: FileSystemDirectoryHandle, name: string, data: string | Blob): Promise<void> {
    const handle = await dir.getFileHandle(name, { create: true })
    const stream = await handle.createWritable()
    try { await stream.write(data); await stream.close() } catch (error) { await stream.abort().catch(() => undefined); throw error }
  }
  async function entries(dir: FileSystemDirectoryHandle): Promise<[string, FileSystemHandle][]> {
    const result: [string, FileSystemHandle][] = []
    for await (const entry of (dir as FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }).entries()) result.push(entry)
    return result
  }
  async function getRun(id: string): Promise<GenerationRecord | undefined> {
    try {
      const text = await read(await directory(id), 'manifest.json')
      if (!text) return undefined
      const run: unknown = JSON.parse(text)
      assertGenerationRecord(run)
      if (run.id !== id) throw new Error('Generation directory does not match its manifest')
      return run
    } catch (error) { if (error instanceof DOMException && error.name === 'NotFoundError') return undefined; throw error }
  }
  async function getEvents(id: string): Promise<JournalEvent[]> {
    try {
      const text = await read(await directory(id), 'events.jsonl')
      return text ? text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as JournalEvent).sort((a, b) => a.sequence - b.sequence) : []
    } catch (error) { if (error instanceof DOMException && error.name === 'NotFoundError') return []; throw error }
  }
  async function getArtifacts(id: string): Promise<JournalArtifact[]> {
    let dir: FileSystemDirectoryHandle
    try { dir = await directory(id, 'artifacts') } catch (error) { if (error instanceof DOMException && error.name === 'NotFoundError') return []; throw error }
    const artifacts: JournalArtifact[] = []
    for (const [name, handle] of await entries(dir)) {
      if (handle.kind !== 'file' || !name.endsWith('.json') || !isJournalId(name.slice(0, -5))) continue
      const metadata = JSON.parse((await read(dir, name))!) as Omit<JournalArtifact, 'blob'>
      if (metadata.id !== name.slice(0, -5) || metadata.generationId !== id) throw new Error('Invalid artifact metadata')
      const blob = await (await dir.getFileHandle(`${safe(metadata.id)}.bin`)).getFile()
      artifacts.push({ ...metadata, blob: blob.slice(0, blob.size, metadata.mime) })
    }
    return artifacts
  }
  async function remove(id: string): Promise<void> {
    try { await root.removeEntry(safe(id), { recursive: true }) } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error
    }
  }
  return {
    getRun, getEvents, getArtifacts,
    async listRuns() {
      const runs: GenerationRecord[] = []
      for (const [name, handle] of await entries(root)) if (handle.kind === 'directory' && isJournalId(name)) {
        const run = await getRun(name)
        if (run) runs.push(run)
      }
      return runs.sort((a, b) => b.createdAt - a.createdAt)
    },
    async putRun(run) {
      const old = await getRun(run.id)
      if (old && (old.updatedAt > run.updatedAt || (old.request && JSON.stringify(old.request) !== JSON.stringify(run.request)))) throw new Error('Generation changed during synchronization')
      const dir = await directory(run.id, undefined, true)
      const requests = await directory(run.id, 'requests', true)
      await directory(run.id, 'responses', true)
      if (run.request) await write(requests, 'original.json', JSON.stringify(run.request))
      await write(dir, 'manifest.json', JSON.stringify(run))
    },
    async putEvent(event) {
      const dir = await directory(event.generationId, undefined, true)
      const events = await getEvents(event.generationId)
      const old = events.find((item) => item.id === event.id || item.sequence === event.sequence)
      if (old) {
        if (JSON.stringify(old) !== JSON.stringify(event)) throw new Error('Conflicting journal event')
        return
      }
      events.push(event)
      if (event.kind === 'request' || event.kind === 'response') await write(await directory(event.generationId, event.kind === 'request' ? 'requests' : 'responses', true), `${safe(event.id)}.json`, JSON.stringify(event))
      await write(dir, 'events.jsonl', events.sort((a, b) => a.sequence - b.sequence).map((item) => JSON.stringify(item)).join('\n') + '\n')
    },
    async putArtifact(artifact) {
      const dir = await directory(artifact.generationId, 'artifacts', true)
      const { blob, ...metadata } = artifact
      const name = `${safe(artifact.id)}.json`
      const old = await read(dir, name)
      if (old) {
        if (old !== JSON.stringify(metadata)) throw new Error('Cannot overwrite an immutable artifact')
        return
      }
      await write(dir, `${artifact.id}.bin`, blob)
      await write(dir, name, JSON.stringify(metadata))
    },
    async getArtifact(id) {
      safe(id)
      const shared = (await getArtifacts(id)).find((item) => item.id === id)
      if (shared) return shared
      for (const [name, handle] of await entries(root)) if (handle.kind === 'directory' && isJournalId(name)) {
        const artifact = (await getArtifacts(name)).find((item) => item.id === id)
        if (artifact) return artifact
      }
      return undefined
    },
    async deleteRun(id) {
      const run = await getRun(id).catch(() => undefined)
      await remove(id)
      if (!run?.inputs?.length) return
      const remaining = await this.listRuns()
      for (const input of run.inputs) if (!remaining.some((other) => other.inputs?.includes(input))) await remove(input)
    },
  }
}

function folderMirror(root: FileSystemDirectoryHandle): JournalMirror {
  const store = directoryStore(root)
  async function locked(id: string, action: () => Promise<void>): Promise<void> {
    if (!isJournalId(id)) throw new Error('Invalid generation ID')
    const claim = `${id}.browser-${crypto.randomUUID()}.lock`
    await root.getDirectoryHandle(claim, { create: true })
    try {
      const entries = (root as FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }).entries()
      for await (const [name] of entries) {
        if (name === `${id}.lock` || (name !== claim && name.startsWith(`${id}.browser-`) && name.endsWith('.lock'))) {
          throw new Error('Journal is busy. Sync again after other writers finish.')
        }
      }
      await action()
    } finally { await root.removeEntry(claim, { recursive: true }) }
  }
  return {
    listRuns: () => store.listRuns(),
    read: (id) => getBundle(store, id),
    write: (bundle) => locked(bundle.run.id, () => importBundle(store, bundle)),
    putRun: (run) => locked(run.id, () => store.putRun(run)),
    putEvent: (event) => locked(event.generationId, () => store.putEvent(event)),
    putArtifact: (artifact) => locked(artifact.generationId, () => store.putArtifact(artifact)),
    deleteRun: (id) => locked(id, () => store.deleteRun(id)),
  }
}

function desktopStore(bridge: DesktopJournalBridge): JournalMirror {
  return {
    listRuns: () => bridge.list(),
    async read(id) {
      const bundle = await bridge.read(id)
      return { ...bundle, artifacts: bundle.artifacts.map(({ bytes, ...artifact }) => ({ ...artifact, blob: new Blob([bytes], { type: artifact.mime }) })) }
    },
    async write(bundle) {
      await bridge.write({ ...bundle, artifacts: await Promise.all(bundle.artifacts.map(async ({ blob, ...artifact }) => ({ ...artifact, bytes: await blob.arrayBuffer() }))) })
    },
    putRun: (run) => bridge.putRun(run),
    putEvent: (event) => bridge.putEvent(event),
    async putArtifact({ blob, ...artifact }) {
      await bridge.putArtifact({ ...artifact, bytes: await blob.arrayBuffer() })
    },
    deleteRun: (id) => bridge.delete(id),
  }
}

function enqueue(id: string, step: () => Promise<void>): Promise<void> {
  const done = (writing.get(id) ?? Promise.resolve()).then(step)
  const chain = done.catch(() => undefined)
  writing.set(id, chain)
  void chain.then(() => { if (writing.get(id) === chain) writing.delete(id) })
  return done
}

function writeLive(write: JournalWrite): void {
  const target = mirror
  if (!target) return
  const id = write.kind === 'run' ? write.run.id : write.kind === 'event' ? write.event.generationId : write.artifact.generationId
  if (fromDisk.has(id) || deleted.has(id)) return
  let step: () => Promise<void>
  if (write.kind === 'run') {
    // The capture keeps mutating its run object, so send the record as it was stored.
    const run = structuredClone(write.run)
    step = () => target.putRun(run)
  } else if (write.kind === 'event') step = () => target.putEvent(write.event)
  else step = () => target.putArtifact(write.artifact)
  enqueue(id, step).catch((error: unknown) => {
    dirty.add(id)
    failed(error)
  })
}

export async function initializeRecording(): Promise<void> {
  if (typeof window === 'undefined') return
  initialization ??= (async () => {
    const pending: unknown = JSON.parse(localStorage.getItem(DELETIONS_KEY) ?? '[]')
    if (!Array.isArray(pending) || !pending.every(isJournalId)) throw new Error('Invalid pending journal deletions')
    for (const id of pending) deleted.add(id)
    const bridge = window.kagiDesktop?.journal
    if (bridge) {
      mirror = desktopStore(bridge)
      update({ mode: 'desktop', status: 'ready', location: await bridge.location() })
    } else {
      const handle = await getDirectoryHandle(HANDLE_KEY)
      if (handle) {
        const permission = handle as FileSystemDirectoryHandle & { queryPermission?: (options: { mode: 'readwrite' }) => Promise<PermissionState> }
        if (!permission.queryPermission || await permission.queryPermission({ mode: 'readwrite' }) === 'granted') {
          mirror = folderMirror(handle)
          update({ mode: 'folder', status: 'ready', location: handle.name })
        } else update({ mode: 'folder', status: 'denied', location: handle.name })
      }
    }
    if (!watching) {
      watching = true
      onJournalWrite(writeLive)
      window.addEventListener('focus', () => { void syncJournalFiles().catch(failed) })
    }
    await syncJournalFiles()
    await recoverInterrupted(journalStore)
  })().catch((error: unknown) => { initialization = undefined; failed(error); throw error })
  return initialization
}

export async function chooseJournalFolder(): Promise<void> {
  if (typeof window !== 'undefined' && window.kagiDesktop?.journal) return initializeRecording()
  if (!supportsFileSystemAccess()) throw new Error('Folder access is unavailable. Export or import a journal ZIP instead.')
  const handle = await pickDirectory(HANDLE_KEY)
  if (!handle) return
  mirror = folderMirror(handle)
  update({ mode: 'folder', status: 'ready', location: handle.name })
  await initializeRecording()
  await syncJournalFiles()
}

export async function reconnectJournalFolder(): Promise<void> {
  const handle = await getDirectoryHandle(HANDLE_KEY)
  if (!handle) return chooseJournalFolder()
  if (!await verifyPermission(handle)) {
    mirror = undefined
    update({ mode: 'folder', status: 'denied', location: handle.name })
    return
  }
  mirror = folderMirror(handle)
  update({ mode: 'folder', status: 'ready', location: handle.name })
  await initializeRecording()
  await syncJournalFiles()
}

async function stableBundle(id: string): Promise<JournalBundle> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const version = getJournalVersion()
    const bundle = await getBundle(journalStore, id)
    if (version === getJournalVersion()) { await validateBundle(bundle); return bundle }
  }
  throw new Error('Generation is changing. Sync again after its current request finishes.')
}

export function syncJournalFiles(): Promise<void> {
  const sync = async () => {
    if (!mirror) return
    update({ ...state, status: 'syncing', error: undefined })
    try {
      for (const id of deleted) {
        await journalStore.deleteRun(id)
        await enqueue(id, () => mirror!.deleteRun(id))
        deleted.delete(id)
        dirty.delete(id)
        localStorage.setItem(DELETIONS_KEY, JSON.stringify([...deleted]))
      }
      const disk = await mirror.listRuns()
      for (const run of disk) {
        const local = await journalStore.getRun(run.id)
        if (local && run.updatedAt <= local.updatedAt) continue
        fromDisk.add(run.id)
        try { await importBundle(journalStore, await mirror.read(run.id)) } finally { fromDisk.delete(run.id) }
      }
      const onDisk = new Map(disk.map((run) => [run.id, run.updatedAt]))
      for (const run of await journalStore.listRuns()) {
        if (deleted.has(run.id)) continue
        if (!dirty.has(run.id) && (onDisk.get(run.id) ?? -1) >= run.updatedAt) continue
        const bundle = await stableBundle(run.id)
        const target = mirror
        await enqueue(run.id, () => target.write(bundle))
        dirty.delete(run.id)
      }
      update({ ...state, status: 'ready', error: undefined })
    } catch (error) { failed(error); throw error }
  }
  const pending = queue.then(sync, sync)
  queue = pending.catch(() => undefined)
  return pending
}

/** Each ID goes on the deletions list before anything is removed, so a crash leaves work the next sync finishes and never copies back. */
async function deleteGenerations(ids: readonly string[]): Promise<void> {
  if (!ids.every(isJournalId)) throw new Error('Invalid generation ID')
  for (const id of ids) deleted.add(id)
  localStorage.setItem(DELETIONS_KEY, JSON.stringify([...deleted]))
  for (const id of ids) await journalStore.deleteRun(id)
  await syncJournalFiles()
}

export function deleteJournalGeneration(id: string): Promise<void> {
  return deleteGenerations([id])
}

/** Every run of one adaptation, here and in the journal files, with the shared inputs no other run refers to. */
export async function deleteJournalAdaptation(adaptationId: string): Promise<void> {
  const ids = new Set((await listAdaptationRuns(adaptationId)).map((run) => run.id))
  if (mirror) for (const id of await adaptationRunIds(mirror, adaptationId)) ids.add(id)
  if (ids.size) await deleteGenerations([...ids])
}

export async function exportJournal(ids?: readonly string[]): Promise<void> {
  const writer = new ZipWriter(new BlobWriter('application/zip'), { useWebWorkers: false })
  try {
    for (const id of ids ?? (await journalStore.listRuns()).map((run) => run.id)) {
      const bundle = await stableBundle(id)
      await writer.add(`${id}/manifest.json`, new TextReader(JSON.stringify(bundle.run)))
      await writer.add(`${id}/events.jsonl`, new TextReader(bundle.events.map((event) => JSON.stringify(event)).join('\n')))
      for (const { blob, ...artifact } of bundle.artifacts) {
        await writer.add(`${id}/artifacts/${artifact.id}.json`, new TextReader(JSON.stringify(artifact)))
        await writer.add(`${id}/artifacts/${artifact.id}.bin`, new BlobReader(blob), { level: 0 })
      }
      if (bundle.run.request) await writer.add(`${id}/requests/original.json`, new TextReader(JSON.stringify(bundle.run.request)))
      for (const event of bundle.events) if (event.kind === 'request' || event.kind === 'response') await writer.add(`${id}/${event.kind === 'request' ? 'requests' : 'responses'}/${event.id}.json`, new TextReader(JSON.stringify(event)))
    }
    const url = URL.createObjectURL(await writer.close())
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'kagi-generations.zip'
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch (error) { await writer.close().catch(() => undefined); throw error }
}

export async function importJournal(file: File): Promise<number> {
  const reader = new ZipReader(new BlobReader(file), { useWebWorkers: false })
  try {
    const entries = await reader.getEntries()
    const files = new Map<string, Blob>()
    let total = 0
    if (entries.length > 100_000) throw new Error('Journal archive contains too many files')
    for (const entry of entries) {
      const parts = entry.filename.replace(/\/$/, '').split('/')
      if (!isJournalId(parts[0]) || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\')) || entry.encrypted) throw new Error('Unsafe journal archive path')
      if (entry.directory) continue
      total += entry.uncompressedSize
      if (total > 2_000_000_000 || entry.uncompressedSize > 256_000_000) throw new Error('Journal archive exceeds the import size limit')
      if (files.has(entry.filename)) throw new Error('Duplicate journal archive path')
      files.set(entry.filename, await entry.getData(new BlobWriter(), { checkSignature: true }))
    }
    const bundles: JournalBundle[] = []
    for (const [name, manifest] of files) {
      if (!/^[^/]+\/manifest\.json$/.test(name)) continue
      const run: unknown = JSON.parse(await manifest.text())
      assertGenerationRecord(run)
      if (name !== `${run.id}/manifest.json`) throw new Error('Journal manifest ID mismatch')
      const events = files.get(`${run.id}/events.jsonl`)
      if (!events) throw new Error('Journal event history is missing')
      const artifacts: JournalArtifact[] = []
      for (const [path, metadata] of files) if (path.startsWith(`${run.id}/artifacts/`) && path.endsWith('.json')) {
        const artifact = JSON.parse(await metadata.text()) as Omit<JournalArtifact, 'blob'>
        if (!isJournalId(artifact.id) || path !== `${run.id}/artifacts/${artifact.id}.json`) throw new Error('Invalid journal artifact path')
        const blob = files.get(`${run.id}/artifacts/${artifact.id}.bin`)
        if (!blob) throw new Error('Journal artifact is missing')
        artifacts.push({ ...artifact, blob: blob.slice(0, blob.size, artifact.mime) })
      }
      const bundle = { run, events: (await events.text()).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as JournalEvent), artifacts }
      await validateBundle(bundle)
      bundles.push(bundle)
    }
    if (!bundles.length) throw new Error('No generation records found in the archive')
    for (const bundle of bundles) await importBundle(journalStore, bundle)
    await syncJournalFiles()
    return bundles.length
  } finally { await reader.close() }
}
