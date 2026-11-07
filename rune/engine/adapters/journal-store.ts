import { join, resolve } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createFileJournal } from '../../../desktop/src/journal-store'
import type { FileJournalStore } from '../../../desktop/src/journal-store'
import { dataRoot } from './database'
import type { GenerationRecord, JournalArtifact, JournalBundle, JournalEvent, JournalStore } from '../../../src/lib/adapt/journal/types'
import { importBundle, readBundle, upgradeRecord, upgradeEvents } from '../../../src/lib/adapt/journal/helpers'
import { withNativeJournalLock } from './journal-locks'
import { journalOwnerState, nativeJournalOwner } from './journal-owner'
export type JournalWrite = {kind:'run';run:GenerationRecord} | {kind:'event';event:JournalEvent} | {kind:'artifact';artifact:JournalArtifact}
const listeners = new Set<(write?: JournalWrite) => void>()
const writeListeners = new Set<(write: JournalWrite) => void>()
const held = new Map<string,number>()
const importing = new AsyncLocalStorage<boolean>()
const runtimeOwners = new Set<string>()
const live = new Set<string>()
let writes = 0
let relocating = false
let version = 0
let backend: Promise<FileJournalStore> | undefined
let root: string | undefined
export function journalRoot(): string { return root ?? join(dataRoot(), 'generation-journal') }
export function configureJournal(directory: string): void { root = directory; backend = undefined; changed() }
export function createNativeFileJournal(directory: string, readOnly = false): Promise<FileJournalStore> {
  const path = resolve(directory)
  return createFileJournal(path,{readOnly,isInputHeld:(id) => held.has(id),lock:(id,action) => withNativeJournalLock(path,id,action)})
}
export function nativeJournal(): Promise<FileJournalStore> {
  backend ??= createNativeFileJournal(journalRoot())
  return backend
}
function changed(write?: JournalWrite): void {
  importing.exit(() => { version++; if (write) for (const listener of writeListeners) listener(write); for (const listener of listeners) listener(write) })
}
export function subscribeJournal(listener: (write?: JournalWrite) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }
export function onJournalWrite(listener: (write: JournalWrite) => void): () => void { writeListeners.add(listener); return () => { writeListeners.delete(listener) } }
export function getJournalVersion(): number { return version }
export function beginJournalRelocation(): () => void {
  if (relocating || writes || held.size || live.size) throw new Error('Finish generation and journal writes before changing the journal folder.')
  relocating = true
  let active = true
  return () => { if (active) { active = false; relocating = false } }
}
async function writeJournal<T>(action: () => Promise<T>): Promise<T> {
  if (relocating) throw new Error('The journal folder is changing. Retry when it finishes.')
  writes++
  try { return await action() } finally { writes-- }
}
export function holdInputs(ids: readonly string[]): () => void {
  if (relocating) throw new Error('The journal folder is changing. Retry when it finishes.')
  for (const id of ids) held.set(id,(held.get(id) ?? 0)+1)
  let active = true
  return () => { if (!active) return; active = false; for (const id of ids) { const count = (held.get(id) ?? 1)-1; if (count) held.set(id,count); else held.delete(id) } }
}
export const journalStore: JournalStore = {
  async putRun(run) {
    const saved = structuredClone(run)
    await writeJournal(async () => {
      try {
        if (!importing.getStore() && saved.ownerId.startsWith('node:') && (live.has(saved.id) || runtimeOwners.has(saved.ownerId))) {
          const original = saved.ownerId
          saved.ownerId = await nativeJournalOwner(original)
          runtimeOwners.add(original)
        }
        await (await nativeJournal()).putRun(saved)
      }
      finally { if (!importing.getStore() && saved.status !== 'running') live.delete(saved.id) }
      if (!importing.getStore() && saved.status === 'running') live.add(saved.id)
      changed({kind:'run',run:saved})
    })
  },
  async getRun(id) { return (await nativeJournal()).getRun(id) },
  async listRuns() { return (await nativeJournal()).listRuns() },
  async putEvent(event) {
    const saved = structuredClone(event)
    await writeJournal(async () => {
      await (await nativeJournal()).putEvent(saved)
      if (!importing.getStore() && saved.kind === 'started') live.add(saved.generationId)
      changed({kind:'event',event:saved})
    })
  },
  async getEvents(id) { return (await nativeJournal()).getEvents(id) },
  async putArtifact(artifact) {
    const saved = {...artifact}
    await writeJournal(async () => { await (await nativeJournal()).putArtifact(saved); changed({kind:'artifact',artifact:saved}) })
  },
  async getArtifact(id) { return (await nativeJournal()).getArtifact(id) },
  async getArtifacts(id) { return (await nativeJournal()).getArtifacts(id) },
  async deleteRun(id) {
    if (live.has(id)) throw new Error('Stop generation before deleting its journal.')
    await writeJournal(async () => { await (await nativeJournal()).deleteRun(id); changed() })
  },
}
export async function listAdaptationRuns(id: string): Promise<GenerationRecord[]> { return (await journalStore.listRuns()).filter((run) => run.target?.adaptationId === id) }
export function getBundle(store: JournalStore, id: string): Promise<JournalBundle> { return readBundle(store,id) }
export async function initializeJournal(): Promise<void> {
  const store = await nativeJournal()
  for (const run of await store.listRuns()) {
    const upgraded = await upgradeRecord(run)
    for (const artifact of upgraded.artifacts) await store.putArtifact(artifact)
    const events = await store.getEvents(run.id)
    const kept = upgradeEvents(run,events)
    if (kept.some((event,index) => event !== events[index])) await store.replaceMigratedEvents(run,events,kept)
    if (upgraded.run !== run) await store.putRun(upgraded.run)
  }
}
export async function importNativeJournalBundle(bundle: JournalBundle): Promise<void> {
  if (live.has(bundle.run.id)) throw new Error('Stop generation before importing its journal.')
  await writeJournal(() => importing.run(true,async () => {
    const upgraded = await upgradeRecord(bundle.run)
    const release = holdInputs(upgraded.run.inputs ?? [])
    try { await importBundle(journalStore,bundle) } finally { release() }
  }))
}
export async function recoverInterrupted(store: JournalStore): Promise<void> {
  for (const run of await store.listRuns()) {
    if (run.status !== 'running') continue
    if (live.has(run.id)) continue
    let ownedHere = false
    for (const original of runtimeOwners) if (await nativeJournalOwner(original) === run.ownerId) { ownedHere = true; break }
    if (!ownedHere && await journalOwnerState(run.ownerId) !== 'dead') continue
    const now = Math.max(Date.now(),run.updatedAt+1); const events = await store.getEvents(run.id)
    await store.putEvent({id:crypto.randomUUID(),generationId:run.id,sequence:Math.max(-1,...events.map((event) => event.sequence))+1,at:now,kind:'interrupted',message:'Generation stopped before its result was recorded.'})
    await store.putRun({...run,status:'interrupted',error:'Generation stopped before its result was recorded.',updatedAt:now,finishedAt:now})
  }
}
