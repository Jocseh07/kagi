import { join, resolve } from 'node:path'
import { lstat } from 'node:fs/promises'
import { BlobReader, BlobWriter, TextReader, ZipReader, ZipWriter } from '@zip.js/zip.js'
import { assertGenerationRecord, importBundle, isJournalId, validateBundle } from '../../../src/lib/adapt/journal/helpers'
import type { JournalArtifact, JournalBundle, JournalEvent } from '../../../src/lib/adapt/journal/types'
import type { RecordingState } from '../../../src/lib/adapt/journal/files'
import { beginJournalRelocation, configureJournal, createNativeFileJournal, getBundle, getJournalVersion, importNativeJournalBundle, initializeJournal, journalRoot, journalStore, recoverInterrupted } from './journal-store'
import { atomicWrite, directorySize, ensureDirectory, storageRoot } from './storage'
import { getPreference, setPreference } from './preferences'
export type { RecordingState }
let state: RecordingState = {mode:'desktop',status:'unset',location:null}
const listeners = new Set<() => void>()
let initialization: Promise<void> | undefined
let lastExport: string | undefined
function update(next: RecordingState): void { state = next; for (const listener of listeners) listener() }
export function getRecordingState(): RecordingState { return state }
export function subscribeRecording(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }
export function initializeRecording(): Promise<void> {
  initialization ??= (async () => {
    const location = await getPreference('journal.directory')
    if (location && location !== journalRoot()) configureJournal(location)
    await initializeJournal(); await recoverInterrupted(journalStore)
    update({mode:'desktop',status:'ready',location:journalRoot()})
  })().catch((error: unknown) => { initialization = undefined; update({mode:'desktop',status:'error',location:journalRoot(),error:error instanceof Error ? error.message : String(error)}); throw error })
  return initialization
}
export async function chooseJournalFolder(path?: string): Promise<void> {
  if (!path) throw new Error('Select a journal folder with the native folder picker.')
  await initializeRecording()
  const release = beginJournalRelocation()
  try {
    const destination = resolve(path); const target = await createNativeFileJournal(destination)
    for (const run of await journalStore.listRuns()) await importBundle(target,await getBundle(journalStore,run.id))
    await setPreference('journal.directory',destination)
    configureJournal(destination); initialization = undefined
  } finally { release() }
  await initializeRecording()
}
export async function reconnectJournalFolder(): Promise<void> { initialization = undefined; await initializeRecording() }
export async function syncJournalFiles(): Promise<void> {
  await initializeRecording()
  for (const run of await journalStore.listRuns()) await validateBundle(await getBundle(journalStore,run.id))
  update({mode:'desktop',status:'ready',location:journalRoot()})
}
export async function deleteJournalGeneration(id: string): Promise<void> { if (!isJournalId(id)) throw new Error('Invalid generation ID'); await initializeRecording(); await journalStore.deleteRun(id) }
export async function deleteJournalAdaptation(id: string): Promise<void> { await initializeRecording(); for (const run of await journalStore.listRuns()) if (run.target?.adaptationId === id) await journalStore.deleteRun(run.id) }
async function stableBundle(id: string): Promise<JournalBundle> {
  for (let attempt = 0; attempt < 5; attempt++) { const version = getJournalVersion(); const bundle = await getBundle(journalStore,id); if (version === getJournalVersion()) { await validateBundle(bundle); return bundle } }
  throw new Error('Generation is changing. Export after its current request finishes.')
}
export async function exportJournal(ids?: readonly string[], destination?: string): Promise<void> {
  await initializeRecording()
  const writer = new ZipWriter(new BlobWriter('application/zip'),{useWebWorkers:false})
  try {
    for (const id of ids ?? (await journalStore.listRuns()).map((run) => run.id)) {
      const bundle = await stableBundle(id)
      await writer.add(`${id}/manifest.json`,new TextReader(JSON.stringify(bundle.run)))
      await writer.add(`${id}/events.jsonl`,new TextReader(bundle.events.map((event) => JSON.stringify(event)).join('\n')))
      for (const {blob,...artifact} of bundle.artifacts) {
        await writer.add(`${id}/artifacts/${artifact.id}.json`,new TextReader(JSON.stringify(artifact)))
        await writer.add(`${id}/artifacts/${artifact.id}.bin`,new BlobReader(blob),{level:0})
      }
      if (bundle.run.request) await writer.add(`${id}/requests/original.json`,new TextReader(JSON.stringify(bundle.run.request)))
      for (const event of bundle.events) if (event.kind === 'request' || event.kind === 'response') await writer.add(`${id}/${event.kind === 'request' ? 'requests' : 'responses'}/${event.id}.json`,new TextReader(JSON.stringify(event)))
    }
    const path = destination ? resolve(destination) : join(storageRoot(),'exports',`kagi-generations-${Date.now()}.zip`)
    await atomicWrite(path,await writer.close()); lastExport = path
  } catch (error) { await writer.close().catch(() => undefined); throw error }
}
export function lastJournalExportPath(): string | undefined { return lastExport }
export async function importJournal(file: File | string): Promise<number> {
  await initializeRecording()
  const blob = typeof file === 'string' ? Bun.file(file) : file
  const reader = new ZipReader(new BlobReader(blob),{useWebWorkers:false})
  try {
    const entries = await reader.getEntries(); const files = new Map<string,Blob>(); let total = 0
    if (entries.length > 100_000) throw new Error('Journal archive contains too many files')
    for (const entry of entries) {
      const parts = entry.filename.replace(/\/$/,'').split('/')
      if (!isJournalId(parts[0]) || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\')) || entry.encrypted) throw new Error('Unsafe journal archive path')
      if (entry.directory) continue
      total += entry.uncompressedSize
      if (total > 2_000_000_000 || entry.uncompressedSize > 256_000_000) throw new Error('Journal archive exceeds the import size limit')
      if (files.has(entry.filename)) throw new Error('Duplicate journal archive path')
      files.set(entry.filename,await entry.getData(new BlobWriter(),{checkSignature:true}))
    }
    const bundles: JournalBundle[] = []
    for (const [name,manifest] of files) {
      if (!/^[^/]+\/manifest\.json$/.test(name)) continue
      const run: unknown = JSON.parse(await manifest.text()); assertGenerationRecord(run)
      if (name !== `${run.id}/manifest.json`) throw new Error('Journal manifest ID mismatch')
      const events = files.get(`${run.id}/events.jsonl`); if (!events) throw new Error('Journal event history is missing')
      const artifacts: JournalArtifact[] = []
      for (const [path,metadata] of files) if (path.startsWith(`${run.id}/artifacts/`) && path.endsWith('.json')) {
        const artifact = JSON.parse(await metadata.text()) as Omit<JournalArtifact,'blob'>
        if (!isJournalId(artifact.id) || path !== `${run.id}/artifacts/${artifact.id}.json`) throw new Error('Invalid journal artifact path')
        const blob = files.get(`${run.id}/artifacts/${artifact.id}.bin`); if (!blob) throw new Error('Journal artifact is missing')
        artifacts.push({...artifact,blob:blob.slice(0,blob.size,artifact.mime)})
      }
      const bundle = {run,events:(await events.text()).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as JournalEvent),artifacts}
      await validateBundle(bundle); bundles.push(bundle)
    }
    if (!bundles.length) throw new Error('No generation records found in the archive')
    for (const bundle of bundles) await importNativeJournalBundle(bundle)
    return bundles.length
  } finally { await reader.close() }
}
export async function importJournalFolder(directory: string): Promise<number> {
  await initializeRecording()
  const source = await createNativeFileJournal(resolve(directory),true); const runs = await source.listRuns()
  for (const run of runs) { const bundle = await getBundle(source,run.id); await validateBundle(bundle); await importNativeJournalBundle(bundle) }
  return runs.length
}
export async function exportJournalFolder(directory: string, ids?: readonly string[]): Promise<void> {
  await initializeRecording()
  await ensureDirectory(directory); const target = await createNativeFileJournal(resolve(directory))
  for (const id of ids ?? (await journalStore.listRuns()).map((run) => run.id)) await importBundle(target,await stableBundle(id))
}
export async function pruneJournal(options: {before?:number;maxBytes?:number}): Promise<number> {
  await initializeRecording()
  const runs = await journalStore.listRuns(); const counted = new Set<string>(); let total = 0; let removed = 0
  for (const run of runs) {
    const directories = [run.id,...run.inputs ?? []].filter((id) => !counted.has(id))
    let bytes = 0
    for (const id of directories) bytes += (await directorySize(join(journalRoot(),id))).bytes
    if (run.status !== 'running' && ((options.before !== undefined && run.createdAt < options.before) || (options.maxBytes !== undefined && total+bytes > options.maxBytes))) { await journalStore.deleteRun(run.id); removed++ }
    else { total += bytes; for (const id of directories) counted.add(id) }
  }
  return removed
}
export function exportJournalTo(destination: string, ids?: readonly string[]): Promise<void> { return exportJournal(ids,destination) }
export async function importJournalFrom(path: string): Promise<number> { return (await lstat(path)).isDirectory() ? importJournalFolder(path) : importJournal(path) }
export function setJournalFolder(path: string): Promise<void> { return chooseJournalFolder(path) }
