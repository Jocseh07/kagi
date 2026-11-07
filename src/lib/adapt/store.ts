// Own IndexedDB database: sheets and pages are blobs, scripts are large, and none of it syncs.
import { chapterId, generationStateIdentity, panelKey } from './keys'
import { openDB } from 'idb'
import type { DBSchema, IDBPDatabase, IDBPTransaction } from 'idb'

import type { Align, Frame, Gap, LayoutName } from './layouts'

export type AdaptStyle = 'manga' | 'webtoon' | 'sketch'

export type AdaptationStatus = 'active' | 'paused' | 'stopped'

export interface NovelChapterRef {
  /** 1-based position in the novel's chapter list, oldest first. */
  index: number
  url: string
  name: string
  memo?: Record<string, unknown>
  /** Set when the source chapter is too long for one manga chapter: this one adapts part `index` of `total`. */
  part?: { index: number; total: number }
}

/** Manga chapter numbers drawn together before the usual oldest-first order resumes. */
export interface DrawRange {
  from: number
  to: number
}

export interface Adaptation {
  id: string
  sourceId: string
  novelUrl: string
  novelMemo?: Record<string, unknown>
  title: string
  author?: string
  thumbnailUrl?: string
  style: AdaptStyle
  styleNotes: string
  novelChapterCount: number
  /** Novel chapters read by the planner so far, counted from the first. */
  readThrough: number
  skipped: number[]
  /** Skipped novel chapters that had no text, so a novel with none can say so. */
  empty?: number[]
  drawRange?: DrawRange
  /** Last novel chapter to adapt; unset reads to the end. */
  stopAt?: number
  status: AdaptationStatus
  error: string | null
  checkedAt: number
  createdAt: number
  /** Stored sheets and pages, kept current by `putBlob` and `deleteBlob`. */
  bytes?: number
  /** Recurring vehicles, objects and creatures, so every panel draws the same one. */
  props?: Prop[]
  /** Settings scenes return to, each with its own sheet. */
  places?: Place[]
  /** What the planner knows so far; the next batch and every storyboard read it. */
  memory?: StoryMemory
  /** Lets the opening batch leave out a prologue that adds nothing. */
  skipPrologue: boolean
  /** Each new panel is checked against its sheets and redrawn when it misses. */
  checkPanels: boolean
  blobVersions?: Record<string, string>
}

export interface StoryMemory {
  summary: string
  threads: string[]
  /** Last novel chapter the summary covers. */
  updatedThrough: number
}

export type PropKind = 'vehicle' | 'object' | 'creature'

export interface Prop {
  id: string
  name: string
  kind: PropKind
  description: string
  /** Absent until a script uses the prop and its sheet is drawn. */
  sheetKey?: string
}

export interface Place {
  id: string
  name: string
  description: string
  /** Absent until a script uses the place and its sheet is drawn. */
  sheetKey?: string
}

export interface Look {
  /** `<character id>@<look slug>`, the id scripts reference. */
  id: string
  name: string
  /** What differs from the main look; empty for the main look itself. */
  change: string
  sheetKey: string | null
}

export interface Character {
  id: string
  adaptationId: string
  name: string
  role: string
  appearance: string
  firstNovelChapter: number
  looks: Look[]
  /** Where the character is at the end of the latest planned batch: look, place, injuries, items. */
  now?: string
}

export type TextKind = 'speech' | 'thought' | 'caption' | 'sfx'
export type Anchor = 'tl' | 'tr' | 'bl' | 'br'
export type SpeakerAt = 'left' | 'center' | 'right' | 'off'

export interface TextItem {
  kind: TextKind
  speaker?: string
  line: string
  anchor: Anchor
  /** Where the speaker stands in the frame; absent on scripts written before tails. */
  speakerAt?: SpeakerAt
}

export type CheckStatus = 'disabled' | 'pending' | 'unchecked' | 'passed' | 'flagged' | 'kept'

export interface PanelCheck {
  status: CheckStatus
  issue?: string
  tries: number
  redrawId?: string
}

export interface ScriptPanel {
  /** Index into the chapter's beats; absent on scripts written before beats. */
  beat?: number
  /** Place id; absent when the panel has no tracked place. */
  place?: string
  /** Camera height and direction, e.g. "eye level from the doorway". */
  camera?: string
  shot: string
  looks: string[]
  /** Prop ids; absent on scripts written before props were tracked. */
  props?: string[]
  prompt: string
  text: TextItem[]
  /** Strip layouts only. */
  frame?: Frame
  /** Strip layouts only: the white space after this panel. */
  gapAfter?: Gap
  /** Strip layouts only. */
  align?: Align
  /** Set once the panel check has run on the drawn panel. */
  check?: PanelCheck
}

export type BeatWeight = 'key' | 'normal'

export interface Beat {
  moment: string
  weight: BeatWeight
  place?: string
  /** Character ids. */
  cast: string[]
  /** `[speaker, line]`, quoted from the novel. */
  lines: [string, string][]
}

export interface RedrawRequest {
  id?: string
  page: number
  /** Only this panel is redrawn; the whole page when absent. */
  panel?: number
  note: string
}

export type StripTone = 'light' | 'dark'

export interface ScriptPage {
  layout: LayoutName
  panels: ScriptPanel[]
  /** Strip layouts only: the gutter colour. */
  tone?: StripTone
}

/** Beats for the novel text from character `from` up to `to`, saved before the whole chapter's beats are done. */
export interface BeatPart {
  from: number
  to: number
  beats: Beat[]
  cut: string[]
}

/** Pages for beats `from` up to `to`, saved before the whole storyboard is done. */
export interface ScriptPart {
  from: number
  to: number
  pages: ScriptPage[]
}

export type ChapterStatus = 'queued' | 'drawing' | 'drawn' | 'stopped'

export interface MangaChapter {
  /** `<adaptation id>:<number>`. */
  id: string
  adaptationId: string
  number: number
  title: string
  summary: string
  novelChapters: NovelChapterRef[]
  /** Which planner pass produced it, for grouping. */
  plan: number
  status: ChapterStatus
  script: ScriptPage[] | null
  /** Absent on chapters scripted before beats. */
  beats?: Beat[] | null
  contextMemory?: StoryMemory | null
  /** Quoted novel lines the beats leave out on purpose. */
  cut?: string[]
  /** Finished parts of beats still being written; cleared once `beats` is saved. */
  beatParts?: BeatPart[]
  /** Finished parts of a storyboard still being written; cleared once `script` is saved. */
  scriptParts?: ScriptPart[]
  /** Your note for the next storyboard of this chapter, set by Rewrite script. */
  scriptNote?: string
  /** Character id to the look id they wear for this whole chapter; absent for a character free to change looks. */
  wearing?: Record<string, string>
  pageCount: number
  panelsDone: number
  panelsTotal: number
  /** Pages or panels waiting to be redrawn, with the note for each. */
  redraw: RedrawRequest[]
  drawnAt: number | null
  error: string | null
}

interface AdaptDb extends DBSchema {
  adaptations: { key: string; value: Adaptation }
  characters: { key: string; value: Character; indexes: { byAdaptation: string } }
  chapters: { key: string; value: MangaChapter; indexes: { byAdaptation: string } }
  blobs: { key: string; value: Blob }
  texts: { key: string; value: string }
}

const DB_NAME = 'kagi-adaptations'
const DB_VERSION = 3

let dbPromise: Promise<IDBPDatabase<AdaptDb>> | undefined

function getDb(): Promise<IDBPDatabase<AdaptDb>> {
  dbPromise ??= openDB<AdaptDb>(DB_NAME, DB_VERSION, {
    async upgrade(db, oldVersion, _newVersion, transaction) {
      if (oldVersion < 1) {
        db.createObjectStore('adaptations', { keyPath: 'id' })
        db.createObjectStore('characters', { keyPath: 'id' }).createIndex('byAdaptation', 'adaptationId')
        db.createObjectStore('chapters', { keyPath: 'id' }).createIndex('byAdaptation', 'adaptationId')
        db.createObjectStore('blobs')
      }
      if (oldVersion < 2) db.createObjectStore('texts')
      if (oldVersion >= 1 && oldVersion < 3) await movePlaces(transaction.objectStore('adaptations'))
    },
  })
  return dbPromise
}

type LegacyProp = Omit<Prop, 'kind'> & { kind: PropKind | 'place' }

/** Version 3: places leave the props list for their own, keeping ids and sheets. */
async function movePlaces(store: { getAll(): Promise<Adaptation[]>; put(value: Adaptation): Promise<unknown> }): Promise<void> {
  for (const adaptation of await store.getAll()) {
    const props = (adaptation.props ?? []) as LegacyProp[]
    const places: Place[] = props
      .filter((prop) => prop.kind === 'place')
      .map(({ id, name, description, sheetKey }) => ({ id, name, description, ...(sheetKey ? { sheetKey } : {}) }))
    await store.put({
      ...adaptation,
      props: props.filter((prop): prop is Prop => prop.kind !== 'place'),
      places: [...(adaptation.places ?? []), ...places],
      skipPrologue: adaptation.skipPrologue ?? true,
      checkPanels: adaptation.checkPanels ?? false,
    })
  }
}

export function supportsAdaptations(): boolean {
  return typeof indexedDB !== 'undefined' && typeof OffscreenCanvas !== 'undefined'
}

// ---------------------------------------------------------------- changes --

let version = 0
const listeners = new Set<() => void>()

export function subscribeAdaptStore(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getAdaptStoreVersion(): number {
  return version
}

function changed(): void {
  version++
  for (const listener of listeners) listener()
}

// ------------------------------------------------------------ adaptations --

export async function listAdaptations(): Promise<Adaptation[]> {
  const all = await (await getDb()).getAll('adaptations')
  return all.sort((a, b) => a.createdAt - b.createdAt)
}

export async function getAdaptation(id: string): Promise<Adaptation | undefined> {
  return (await getDb()).get('adaptations', id)
}

export async function findAdaptationByNovel(
  sourceId: string,
  novelUrl: string,
): Promise<Adaptation | undefined> {
  const all = await listAdaptations()
  return all.find((item) => item.sourceId === sourceId && item.novelUrl === novelUrl)
}

export async function putAdaptation(adaptation: Adaptation): Promise<void> {
  await (await getDb()).put('adaptations', adaptation)
  changed()
}

export async function updateAdaptation(
  id: string,
  patch: Partial<Omit<Adaptation, 'id'>>,
): Promise<Adaptation | undefined> {
  const tx = (await getDb()).transaction('adaptations', 'readwrite')
  const current = await tx.store.get(id)
  if (!current) return undefined
  const next = { ...current, ...patch }
  await tx.store.put(next)
  await tx.done
  changed()
  return next
}

/** Records first, then blobs: a crash in between leaves blobs a clear can still find. */
export async function deleteAdaptation(id: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['adaptations', 'characters', 'chapters'], 'readwrite')
  await tx.objectStore('adaptations').delete(id)
  for (const key of await tx.objectStore('characters').index('byAdaptation').getAllKeys(id)) {
    await tx.objectStore('characters').delete(key)
  }
  for (const key of await tx.objectStore('chapters').index('byAdaptation').getAllKeys(id)) {
    await tx.objectStore('chapters').delete(key)
  }
  await tx.done
  await deleteBlobsWithPrefix(`${id}/`)
  await db.delete('texts', prefixRange(`${id}/`))
  changed()
}

function prefixRange(prefix: string): IDBKeyRange {
  return IDBKeyRange.bound(prefix, `${prefix}\uffff`)
}

// ------------------------------------------------------------- characters --

export async function listCharacters(adaptationId: string): Promise<Character[]> {
  const all = await (await getDb()).getAllFromIndex('characters', 'byAdaptation', adaptationId)
  return all.sort((a, b) => a.firstNovelChapter - b.firstNovelChapter || a.name.localeCompare(b.name))
}

export async function putCharacter(character: Character): Promise<void> {
  await (await getDb()).put('characters', character)
  changed()
}

/** One transaction, so looks of the same character drawn in parallel never overwrite each other. */
export async function setSheetKey(characterId: string, lookId: string, key: string): Promise<void> {
  const tx = (await getDb()).transaction('characters', 'readwrite')
  const current = await tx.store.get(characterId)
  if (!current) return
  await tx.store.put({
    ...current,
    looks: current.looks.map((look) => (look.id === lookId ? { ...look, sheetKey: key } : look)),
  })
  await tx.done
  changed()
}

// ------------------------------------------------------------------ props --

/** Props are edited in one transaction, so sheets drawn in parallel and a new plan never overwrite each other. */
async function editProps(adaptationId: string, edit: (props: Prop[]) => Prop[]): Promise<void> {
  const tx = (await getDb()).transaction('adaptations', 'readwrite')
  const current = await tx.store.get(adaptationId)
  if (!current) return
  await tx.store.put({ ...current, props: edit(current.props ?? []) })
  await tx.done
  changed()
}

export function patchProp(adaptationId: string, propId: string, patch: Partial<Omit<Prop, 'id'>>): Promise<void> {
  return editProps(adaptationId, (props) => props.map((prop) => (prop.id === propId ? { ...prop, ...patch } : prop)))
}

/** Appends props whose ids are not stored yet. */
export function addProps(adaptationId: string, added: readonly Prop[]): Promise<void> {
  return editProps(adaptationId, (props) => [...props, ...added.filter((prop) => !props.some((known) => known.id === prop.id))])
}

// ----------------------------------------------------------------- places --

/** Places are edited in one transaction, for the same reason as props. */
async function editPlaces(adaptationId: string, edit: (places: Place[]) => Place[]): Promise<void> {
  const tx = (await getDb()).transaction('adaptations', 'readwrite')
  const current = await tx.store.get(adaptationId)
  if (!current) return
  await tx.store.put({ ...current, places: edit(current.places ?? []) })
  await tx.done
  changed()
}

export function patchPlace(adaptationId: string, placeId: string, patch: Partial<Omit<Place, 'id'>>): Promise<void> {
  return editPlaces(adaptationId, (places) => places.map((place) => (place.id === placeId ? { ...place, ...patch } : place)))
}

/** Appends places whose ids are not stored yet. */
export function addPlaces(adaptationId: string, added: readonly Place[]): Promise<void> {
  return editPlaces(adaptationId, (places) => [...places, ...added.filter((place) => !places.some((known) => known.id === place.id))])
}

// --------------------------------------------------------------- chapters --

export async function listChapters(adaptationId: string): Promise<MangaChapter[]> {
  const all = await (await getDb()).getAllFromIndex('chapters', 'byAdaptation', adaptationId)
  return all.sort((a, b) => a.number - b.number)
}

export async function getChapter(adaptationId: string, number: number): Promise<MangaChapter | undefined> {
  return (await getDb()).get('chapters', chapterId(adaptationId, number))
}

export async function putChapter(chapter: MangaChapter): Promise<void> {
  await (await getDb()).put('chapters', chapter)
  changed()
}

export async function updateChapter(
  adaptationId: string,
  number: number,
  patch: Partial<Omit<MangaChapter, 'id'>>,
): Promise<MangaChapter | undefined> {
  const tx = (await getDb()).transaction('chapters', 'readwrite')
  const current = await tx.store.get(chapterId(adaptationId, number))
  if (!current) return undefined
  const next = { ...current, ...patch }
  await tx.store.put(next)
  await tx.done
  changed()
  return next
}

export async function patchPanelChecks(
  adaptationId: string,
  number: number,
  checks: ReadonlyMap<string, PanelCheck | undefined>,
): Promise<void> {
  if (!checks.size) return
  const tx = (await getDb()).transaction('chapters', 'readwrite')
  const chapter = await tx.store.get(chapterId(adaptationId, number))
  if (!chapter?.script) return
  chapter.script = chapter.script.map((page, pageIndex) => ({
    ...page,
    panels: page.panels.map((panel, panelIndex) => {
      const id = `${pageIndex + 1}-${panelIndex + 1}`
      return checks.has(id) ? { ...panel, check: checks.get(id) } : panel
    }),
  }))
  await tx.store.put(chapter)
  await tx.done
  changed()
}

// ------------------------------------------------------------------ blobs --

export async function getBlob(key: string): Promise<Blob | undefined> {
  return (await getDb()).get('blobs', key)
}

const blobListeners = new Map<string, Set<() => void>>()

/** Fires when `key` is written or deleted, so one image can refresh without the whole store. */
export function subscribeBlob(key: string, listener: () => void): () => void {
  const set = blobListeners.get(key) ?? new Set()
  set.add(listener)
  blobListeners.set(key, set)
  return () => {
    set.delete(listener)
    if (!set.size) blobListeners.delete(key)
  }
}

function blobChanged(key: string): void {
  for (const listener of blobListeners.get(key) ?? []) listener()
}

function adaptationIdOf(key: string): string {
  return key.slice(0, key.indexOf('/'))
}

/** Writes the blob and moves the owning adaptation's byte total in the same transaction. */
async function writeBlob(key: string, blob: Blob | undefined): Promise<void> {
  const tx = (await getDb()).transaction(['blobs', 'adaptations'], 'readwrite')
  const blobs = tx.objectStore('blobs')
  const rows = tx.objectStore('adaptations')
  const previous = (await blobs.get(key))?.size ?? 0
  if (blob) await blobs.put(blob, key)
  else await blobs.delete(key)
  const row = await rows.get(adaptationIdOf(key))
  if (row) await rows.put({ ...row, ...(row.bytes === undefined ? {} : { bytes: Math.max(0, row.bytes - previous + (blob?.size ?? 0)) }), blobVersions: { ...row.blobVersions, [key]: crypto.randomUUID() } })
  await tx.done
  blobChanged(key)
}

export function putBlob(key: string, blob: Blob): Promise<void> {
  return writeBlob(key, blob)
}

export async function putPanelImage(
  adaptationId: string,
  chapterNumber: number,
  page: number,
  panel: number,
  image: Blob,
  check: PanelCheck,
): Promise<void> {
  const key = panelKey(adaptationId, chapterNumber, page, panel)
  const tx = (await getDb()).transaction(['blobs', 'adaptations', 'chapters'], 'readwrite')
  const blobs = tx.objectStore('blobs')
  const adaptations = tx.objectStore('adaptations')
  const chapters = tx.objectStore('chapters')
  const previous = (await blobs.get(key))?.size ?? 0
  await blobs.put(image, key)
  const adaptation = await adaptations.get(adaptationId)
  if (adaptation) {
    await adaptations.put({ ...adaptation, ...(adaptation.bytes === undefined ? {} : { bytes: Math.max(0, adaptation.bytes - previous + image.size) }), blobVersions: { ...adaptation.blobVersions, [key]: crypto.randomUUID() } })
  }
  const chapter = await chapters.get(chapterId(adaptationId, chapterNumber))
  const target = chapter?.script?.[page - 1]?.panels[panel - 1]
  if (chapter && target) {
    target.check = check
    await chapters.put(chapter)
  }
  await tx.done
  blobChanged(key)
  changed()
}

export function deleteBlob(key: string): Promise<void> {
  return writeBlob(key, undefined)
}

/** Panel blobs of one chapter, as `<page>-<panel>`; kept after composing so lines can be re-lettered without a redraw. */
export async function listPanelKeys(adaptationId: string, chapterNumber: number): Promise<string[]> {
  const prefix = `${adaptationId}/panel/${chapterNumber}/`
  const keys = await (await getDb()).getAllKeys('blobs', prefixRange(prefix))
  return keys.map((key) => String(key).slice(prefix.length))
}

export async function listPageKeys(adaptationId: string, chapterNumber: number): Promise<number[]> {
  const prefix = `${adaptationId}/page/${chapterNumber}/`
  const keys = await (await getDb()).getAllKeys('blobs', prefixRange(prefix))
  return keys.map((key) => Number(String(key).slice(prefix.length)))
}

export async function deleteBlobsWithPrefix(prefix: string): Promise<void> {
  const db = await getDb()
  await db.delete('blobs', prefixRange(prefix))
}

// ------------------------------------------------------------------ texts --

export async function getText(key: string): Promise<string | undefined> {
  return (await getDb()).get('texts', key)
}

export async function putText(key: string, text: string): Promise<void> {
  await (await getDb()).put('texts', text, key)
}

export async function deleteTexts(keys: readonly string[]): Promise<void> {
  const tx = (await getDb()).transaction('texts', 'readwrite')
  for (const key of keys) await tx.store.delete(key)
  await tx.done
}

// ---------------------------------------------------------------- storage --

async function sumBlobBytes(db: IDBPDatabase<AdaptDb>, prefix: string): Promise<number> {
  let bytes = 0
  let cursor = await db.transaction('blobs').store.openCursor(prefixRange(prefix))
  while (cursor) {
    bytes += cursor.value.size
    cursor = await cursor.continue()
  }
  return bytes
}

/** Adaptations created before byte totals were kept are summed once and written back. */
export async function adaptationsSize(): Promise<{ bytes: number; count: number }> {
  if (typeof indexedDB === 'undefined') return { bytes: 0, count: 0 }
  const db = await getDb()
  const rows = await db.getAll('adaptations')
  let bytes = 0
  for (const row of rows) {
    if (row.bytes === undefined) {
      const total = await sumBlobBytes(db, `${row.id}/`)
      await updateAdaptation(row.id, { bytes: total })
      bytes += total
    } else {
      bytes += row.bytes
    }
  }
  return { bytes, count: rows.length }
}

export async function clearAllAdaptations(): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const db = await getDb()
  const tx = db.transaction(['adaptations', 'characters', 'chapters', 'blobs', 'texts'], 'readwrite')
  await Promise.all([
    tx.objectStore('adaptations').clear(),
    tx.objectStore('characters').clear(),
    tx.objectStore('chapters').clear(),
    tx.objectStore('blobs').clear(),
    tx.objectStore('texts').clear(),
    tx.done,
  ])
  changed()
}

export interface GenerationState {
  adaptation: Adaptation
  chapters: MangaChapter[]
  characters: Character[]
  blobs: Map<string, Blob>
  texts: Map<string, string>
}

export interface GenerationApplication {
  at: number
  affected: number[]
  originals: string[]
  phase: 'committed' | 'complete'
}

const GENERATION_STORES = ['adaptations', 'chapters', 'characters', 'blobs', 'texts'] as const

async function generationState(
  tx: IDBPTransaction<AdaptDb, typeof GENERATION_STORES, 'readonly' | 'readwrite'>,
  adaptationId: string,
  includeBlobs = true,
): Promise<GenerationState> {
  const adaptation = await tx.objectStore('adaptations').get(adaptationId)
  if (!adaptation) throw new Error('The adaptation no longer exists.')
  const chapters = await tx.objectStore('chapters').index('byAdaptation').getAll(adaptationId)
  const characters = await tx.objectStore('characters').index('byAdaptation').getAll(adaptationId)
  const range = prefixRange(`${adaptationId}/`)
  const blobs = tx.objectStore('blobs')
  const texts = tx.objectStore('texts')
  const blobKeys = includeBlobs ? await blobs.getAllKeys(range) : []
  const blobValues = includeBlobs ? await blobs.getAll(range) : []
  const textKeys = await texts.getAllKeys(range)
  const textValues = await texts.getAll(range)
  return { adaptation, chapters, characters, blobs: new Map(blobKeys.map((key, index) => [key, blobValues[index]])), texts: new Map(textKeys.map((key, index) => [key, textValues[index]])) }
}

export async function readGenerationState(adaptationId: string, includeBlobs = true): Promise<GenerationState> {
  const tx = (await getDb()).transaction(GENERATION_STORES, 'readonly')
  const state = await generationState(tx, adaptationId, includeBlobs)
  await tx.done
  return state
}


export async function commitGenerationState(before: GenerationState, next: GenerationState, generationId: string, application: GenerationApplication): Promise<void> {
  const tx = (await getDb()).transaction(GENERATION_STORES, 'readwrite')
  const current = await generationState(tx, before.adaptation.id)
  if (generationStateIdentity(current) !== generationStateIdentity(before)) {
    tx.abort()
    await tx.done.catch(() => undefined)
    throw new Error('The adaptation changed while the replacement was being prepared. Review it again.')
  }
  const appliedKey = `${before.adaptation.id}/journal/applied/${generationId}`
  if (current.texts.has(appliedKey)) {
    tx.abort()
    await tx.done.catch(() => undefined)
    throw new Error('This generation has already been applied.')
  }
  next.adaptation.bytes = [...next.blobs.values()].reduce((sum, blob) => sum + blob.size, 0)
  const versions = { ...next.adaptation.blobVersions }
  const changedBlobs: string[] = []
  for (const key of new Set([...before.blobs.keys(), ...next.blobs.keys()])) {
    if (before.blobs.get(key) === next.blobs.get(key)) continue
    const blob = next.blobs.get(key)
    if (blob) await tx.objectStore('blobs').put(blob, key)
    else await tx.objectStore('blobs').delete(key)
    versions[key] = crypto.randomUUID()
    changedBlobs.push(key)
  }
  next.adaptation.blobVersions = versions
  await tx.objectStore('adaptations').put(next.adaptation)
  for (const chapter of before.chapters) if (!next.chapters.some((item) => item.id === chapter.id)) await tx.objectStore('chapters').delete(chapter.id)
  for (const chapter of next.chapters) await tx.objectStore('chapters').put(chapter)
  for (const character of before.characters) if (!next.characters.some((item) => item.id === character.id)) await tx.objectStore('characters').delete(character.id)
  for (const character of next.characters) await tx.objectStore('characters').put(character)
  for (const key of before.texts.keys()) if (!next.texts.has(key)) await tx.objectStore('texts').delete(key)
  for (const [key, value] of next.texts) if (before.texts.get(key) !== value) await tx.objectStore('texts').put(value, key)
  await tx.objectStore('texts').put(JSON.stringify(application), appliedKey)
  await tx.done
  for (const key of changedBlobs) blobChanged(key)
  changed()
}

export async function hasPendingGenerationApplication(adaptationId: string): Promise<boolean> {
  const receipts = await (await getDb()).getAll('texts', prefixRange(`${adaptationId}/journal/applied/`))
  return receipts.some((receipt) => (JSON.parse(receipt) as GenerationApplication).phase === 'committed')
}
