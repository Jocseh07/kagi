import { useSyncExternalStore } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { ulid } from 'ulid'

import { getMangaByUrl, setFavorite, upsertChapters, upsertManga } from '@/lib/db/repositories'
import {
  ADAPTED_SOURCE_ID,
  adaptedChapters,
  adaptedSeries,
  adaptedSeriesUrl,
} from '@/lib/sources/adapted'
import { getSource } from '@/lib/sources/registry'
import { isTextSource } from '@/lib/sources/types'
import type { SChapter, SManga } from '@/lib/sources/types'
import { describeError } from '@/lib/ui/describe-error'

import { deleteJournalAdaptation } from './journal/files'
import { invalidatePublishedAdaptation } from './journal/published'
import { captureGeneration, savedGenerationPrompt } from './journal/replacement'
import type { GenerationCapture } from './journal/replacement'
import type { GenerationTarget, JournalOptions } from './journal/types'
import { AdaptApiError, editImage, generateImage, isModerationBlocked, MISSING_ENDPOINT, PROMPT_BLOCKED, SHEET_BLOCKED } from './client'
import { composePage, composeStrip, contactSheet, downscale } from './compose'
import type { StripPanel } from './compose'
import { pastStop, planLimit } from './flow'
import { createFlushSignal } from './flush'
import { createSlots, imageSlots } from './image-slots'
import { clearChapterProgress, clearLive, markPageComposed, markPanelDrawn, panelId, startJob } from './live'
import type { LiveJob } from './live'
import { IMAGE_SIZES } from './layouts'
import type { Frame } from './layouts'
import { writeBeats } from './beats'
import { MAX_CHECK_REDRAWS, checkPanel } from './check'
import type { CheckResult } from './check'
import { planBatch, sourcePart } from './planner'
import type { BatchChapter, Plan } from './planner'
import {
  cleanImagePrompt,
  firstName,
  isMainLook,
  lookAppearance,
  placeSheetPrompt,
  plainText,
  propSheetPrompt,
  sheetPrompt,
  speakerCharacter,
  styleLine,
} from './prompts'
import { writeScript } from './script'
import { readAdaptSettings } from './settings'
import type { AdaptSettings } from './settings'
import { pageKey, panelKey, placeSheetKey, propSheetKey, sheetKey, textKey } from './keys'
import {
  addPlaces,
  addProps,
  deleteAdaptation,
  deleteBlob,
  deleteTexts,
  hasPendingGenerationApplication,
  getAdaptation,
  getBlob,
  getChapter,
  getText,
  listAdaptations,
  listChapters,
  listCharacters,
  listPageKeys,
  listPanelKeys,
  patchPlace,
  patchPanelChecks,
  patchProp,
  putAdaptation,
  putBlob,
  putChapter,
  putPanelImage,
  putCharacter,
  putText,
  setSheetKey,
  updateAdaptation,
  updateChapter,
} from './store'
import type {
  AdaptStyle,
  Adaptation,
  Character,
  DrawRange,
  MangaChapter,
  NovelChapterRef,
  PanelCheck,
  Place,
  Prop,
  ScriptPage,
  ScriptPanel,
  TextItem,
} from './store'

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const MAX_REFS = 4
const MAX_LOOK_REFS = 3

// ---------------------------------------------------------------- activity --

/** Planning, scripting and drawing run side by side, so each lane reports its own part. */
export interface AdaptActivity {
  /** Novel chapters being read by the planner. */
  reading?: [number, number]
  scripting: number[]
  text?: Record<number, { stage: 'beats' | 'script'; startedAt: number; attempt: number; model: string; reason?: string; part?: { index: number; total: number } }>
  drawing: number[]
  redrawing: number[]
  cast?: { chapters: number[]; done: number; total: number }
  /** Panels across every chapter being drawn or redrawn. */
  panels: { done: number; total: number }
}

const IDLE: AdaptActivity = { scripting: [], drawing: [], redrawing: [], panels: { done: 0, total: 0 } }

export function isBusy(activity: AdaptActivity): boolean {
  return Boolean(
    activity.reading ||
      activity.cast ||
      activity.scripting.length ||
      activity.drawing.length ||
      activity.redrawing.length,
  )
}

const activities = new Map<string, AdaptActivity>()
const activitySignal = createFlushSignal()

/** Keeps each unchanged part of the previous activity, so a panel count tick leaves chapter rows untouched; an identical one is not published. */
function setActivity(adaptationId: string, next: AdaptActivity): void {
  const previous = activities.get(adaptationId) ?? IDLE
  const same = <T,>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b)
  const shared: AdaptActivity = {
    reading: same(previous.reading, next.reading) ? previous.reading : next.reading,
    scripting: same(previous.scripting, next.scripting) ? previous.scripting : next.scripting,
    text: same(previous.text, next.text) ? previous.text : next.text,
    drawing: same(previous.drawing, next.drawing) ? previous.drawing : next.drawing,
    redrawing: same(previous.redrawing, next.redrawing) ? previous.redrawing : next.redrawing,
    cast: same(previous.cast, next.cast) ? previous.cast : next.cast,
    panels: same(previous.panels, next.panels) ? previous.panels : next.panels,
  }
  if ((Object.keys(shared) as (keyof AdaptActivity)[]).every((key) => shared[key] === previous[key])) return
  activities.set(adaptationId, shared)
  activitySignal.notify()
}

function clearActivity(adaptationId: string): void {
  if (activities.delete(adaptationId)) activitySignal.notify()
}

export function getAdaptActivity(adaptationId: string): AdaptActivity {
  return activities.get(adaptationId) ?? IDLE
}

export function subscribeAdaptActivity(listener: () => void): () => void {
  return activitySignal.subscribe(listener)
}

export function useAdaptActivity(adaptationId: string): AdaptActivity {
  return useSyncExternalStore(activitySignal.subscribe, () => getAdaptActivity(adaptationId), () => IDLE)
}

// ------------------------------------------------------------------ runner --

let running = false
const workers = new Map<string, AbortController>()
const workerTasks = new Map<string, Promise<void>>()
const replacementLocks = new Set<string>()
let wake: (() => void) | null = null
let woken = false
let queryClient: QueryClient | null = null

/** Idempotent; called once the library database is ready. */
export function startAdaptationRunner(client: QueryClient): void {
  queryClient = client
  if (running) return
  running = true
  void leaveLibrary().catch(() => undefined)
  void loop()
}

/** The novel's library card stands for its adaptation, so adaptations keep no entry of their own. */
async function leaveLibrary(): Promise<void> {
  let changed = false
  for (const adaptation of await listAdaptations()) {
    const row = await getMangaByUrl(ADAPTED_SOURCE_ID, adaptedSeriesUrl(adaptation.id))
    if (!row?.favorite) continue
    await setFavorite(row.id, false)
    changed = true
  }
  if (changed) void queryClient?.invalidateQueries({ queryKey: ['db'] })
}

export function stopAdaptationRunner(): void {
  running = false
  for (const worker of workers.values()) worker.abort()
  wake?.()
  activities.clear()
  activitySignal.notify()
  clearLive()
}

export async function drainAdaptationRunner(): Promise<void> {
  stopAdaptationRunner()
  await Promise.allSettled([...workerTasks.values()])
}

/** Picks up new work now instead of at the next check. */
export function nudgeAdaptationRunner(): void {
  woken = true
  wake?.()
}

function interruptIf(adaptationId: string): void {
  workers.get(adaptationId)?.abort()
}

/** Resolves true when the wait ran out, false when something woke it early. */
function idle(ms: number): Promise<boolean> {
  if (woken) {
    woken = false
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(true), ms)
    function done(timedOut: boolean) {
      clearTimeout(timer)
      wake = null
      woken = false
      resolve(timedOut)
    }
    wake = () => done(false)
  })
}

async function loop(): Promise<void> {
  while (running) {
    for (const adaptation of await listAdaptations()) {
      if (adaptation.status !== 'active' || workers.has(adaptation.id) || workerTasks.has(adaptation.id) || replacementLocks.has(adaptation.id)) continue
      if (hasWork(adaptation, await listChapters(adaptation.id), await listCharacters(adaptation.id))) {
        const run = () => replacementLocks.has(adaptation.id) ? Promise.resolve() : work(adaptation.id)
        const task = (typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request(`kagi-adapt:${adaptation.id}`, run) : run())
          .finally(() => workerTasks.delete(adaptation.id))
        workerTasks.set(adaptation.id, task)
        void task.catch(() => undefined)
      }
    }
    const timedOut = await idle(CHECK_INTERVAL_MS)
    if (running && timedOut) await checkSources()
  }
}

async function work(adaptationId: string): Promise<void> {
  const controller = new AbortController()
  workers.set(adaptationId, controller)
  const lanes = createLanes(adaptationId)
  const tasks = new Set<Promise<void>>()
  const failures: unknown[] = []

  const fail = (cause: unknown) => {
    if (controller.signal.aborted) return
    failures.push(cause)
    // Stops sibling tasks and queued image slots before the failure is recorded.
    controller.abort()
  }
  // Tracked tasks never reject, so racing them only ever wakes the loop.
  const track = (task: Promise<void>) => {
    const tracked: Promise<void> = task.then(() => undefined, fail).finally(() => tasks.delete(tracked))
    tasks.add(tracked)
  }

  try {
    while (running && !controller.signal.aborted) {
      const adaptation = await getAdaptation(adaptationId)
      if (!adaptation || adaptation.status !== 'active') break
      if (await hasPendingGenerationApplication(adaptationId)) break
      const settings = await readAdaptSettings()
      if (!settings.endpoint) {
        failures.push(new AdaptApiError(MISSING_ENDPOINT, 0))
        break
      }
      const chapters = await listChapters(adaptationId)
      const characters = await listCharacters(adaptationId)
      await clearFinishedRange(adaptation, chapters)
      for (const task of schedule(settings, adaptation, chapters, characters, lanes, controller.signal)) track(task)
      if (!tasks.size) break
      await Promise.race(tasks)
    }
  } catch (cause) {
    fail(cause)
  }

  if (tasks.size) {
    controller.abort()
    await Promise.all(tasks)
  }
  try {
    if (failures.length) await stop(adaptationId, describeError(failures[0]))
    else if (!controller.signal.aborted && (await getAdaptation(adaptationId))?.status === 'active') {
      // A chapter that failed on its own waited for the others; now the adaptation stops with its reason.
      const stopped = (await listChapters(adaptationId)).find((chapter) => chapter.status === 'stopped')
      if (stopped) await stop(adaptationId, stopped.error ?? describeError(undefined))
    }
  } finally {
    if (workers.get(adaptationId) === controller) workers.delete(adaptationId)
    clearActivity(adaptationId)
    nudgeAdaptationRunner()
  }
}

async function stop(adaptationId: string, message: string): Promise<void> {
  for (const chapter of await listChapters(adaptationId)) {
    if (chapter.status === 'drawing') await updateChapter(adaptationId, chapter.number, { status: 'stopped', error: message })
  }
  await updateAdaptation(adaptationId, { status: 'stopped', error: message })
}

/** The key or the endpoint is wrong: no chapter can get further, so the whole run stops at once. */
function fatal(cause: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  return cause instanceof AdaptApiError && (cause.status === 0 || cause.status === 401 || cause.status === 403)
}

/** Runs one chapter's step; its own failure stops that chapter and lets the others finish. */
async function ownFailure(adaptationId: string, chapter: number, signal: AbortSignal, run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (cause) {
    if (fatal(cause, signal)) throw cause
    await updateChapter(adaptationId, chapter, { status: 'stopped', error: describeError(cause) })
  }
}

/** Props and places get a sheet only once a written script shows them. */
function scriptedPropIds(chapters: readonly MangaChapter[]): Set<string> {
  return new Set(chapters.flatMap(scriptPropIds))
}

function scriptedPlaceIds(chapters: readonly MangaChapter[]): Set<string> {
  return new Set(chapters.flatMap(scriptPlaceIds))
}

function missingSheet(adaptation: Adaptation, chapters: readonly MangaChapter[], characters: readonly Character[]): boolean {
  if (characters.some((character) => character.looks.some((look) => !look.sheetKey))) return true
  const used = scriptedPropIds(chapters)
  const placed = scriptedPlaceIds(chapters)
  return (
    (adaptation.props ?? []).some((prop) => !prop.sheetKey && used.has(prop.id)) ||
    (adaptation.places ?? []).some((place) => !place.sheetKey && placed.has(place.id))
  )
}

function pending(adaptation: Adaptation, chapter: MangaChapter): boolean {
  return chapter.status !== 'drawn' && chapter.status !== 'stopped' && !pastStop(adaptation, chapter)
}

function hasWork(adaptation: Adaptation, chapters: readonly MangaChapter[], characters: readonly Character[]): boolean {
  return (
    chapters.some((chapter) => pending(adaptation, chapter) || chapter.redraw.length > 0) ||
    missingSheet(adaptation, chapters, characters) ||
    adaptation.readThrough < planLimit(adaptation)
  )
}

// ------------------------------------------------------------------- novel --

function novelOf(adaptation: Adaptation): SManga {
  return {
    url: adaptation.novelUrl,
    title: adaptation.title,
    author: adaptation.author,
    status: 'unknown',
    initialized: true,
    memo: adaptation.novelMemo,
  }
}

function textSourceOf(adaptation: Adaptation) {
  const source = getSource(adaptation.sourceId)
  if (!isTextSource(source)) throw new Error(`${source.name} does not serve novel text.`)
  return source
}

async function novelChapters(adaptation: Adaptation, signal?: AbortSignal): Promise<SChapter[]> {
  const source = textSourceOf(adaptation)
  const update = await source.getMangaUpdate(novelOf(adaptation), { fetchDetails: false, fetchChapters: true }, signal)
  // Sources list newest first; numbers are only trusted when every chapter has one.
  const numbered = update.chapters.every((chapter) => chapter.chapterNumber >= 0)
  return numbered
    ? [...update.chapters].sort((a, b) => a.chapterNumber - b.chapterNumber)
    : [...update.chapters].reverse()
}

/** Fetched once for the planner, then read from the store when the script is written. */
async function chapterText(adaptation: Adaptation, ref: NovelChapterRef, signal?: AbortSignal): Promise<string> {
  const key = textKey(adaptation.id, ref.url)
  const cached = await getText(key)
  if (cached !== undefined) return cached
  const source = textSourceOf(adaptation)
  const chapter: SChapter = { url: ref.url, name: ref.name, chapterNumber: ref.index, memo: ref.memo }
  const text = plainText((await source.getChapterText(novelOf(adaptation), chapter, signal)).html)
  await putText(key, text)
  return text
}

async function checkSources(): Promise<void> {
  for (const adaptation of await listAdaptations()) {
    if (adaptation.status !== 'active') continue
    try {
      const chapters = await novelChapters(adaptation)
      await updateAdaptation(adaptation.id, { novelChapterCount: chapters.length, checkedAt: Date.now() })
    } catch {
      // A source that is down is checked again next time.
    }
  }
}

// ------------------------------------------------------------------- steps --

/** What one adaptation's worker has in flight, kept in memory and published as its activity. */
interface Lanes {
  adaptationId: string
  planning: boolean
  sheets: boolean
  reading?: [number, number]
  scripting: Set<number>
  text: NonNullable<AdaptActivity['text']>
  drawing: Set<number>
  redrawing: Set<number>
  cast?: { chapters: number[]; done: number; total: number }
  panels: { done: number; total: number }
}

function createLanes(adaptationId: string): Lanes {
  return {
    adaptationId,
    planning: false,
    sheets: false,
    scripting: new Set(),
    text: {},
    drawing: new Set(),
    redrawing: new Set(),
    panels: { done: 0, total: 0 },
  }
}

function sorted(numbers: ReadonlySet<number>): number[] {
  return [...numbers].sort((a, b) => a - b)
}

function publishLanes(lanes: Lanes): void {
  setActivity(lanes.adaptationId, {
    reading: lanes.reading,
    scripting: sorted(lanes.scripting),
    text: { ...lanes.text },
    drawing: sorted(lanes.drawing),
    redrawing: sorted(lanes.redrawing),
    cast: lanes.cast && { ...lanes.cast },
    panels: { ...lanes.panels },
  })
}

/** Holds a chapter in a lane for as long as `run` takes; the add happens before the first await. */
async function inLane(lanes: Lanes, lane: Set<number>, chapter: number, run: () => Promise<void>): Promise<void> {
  lane.add(chapter)
  publishLanes(lanes)
  try {
    await run()
  } finally {
    lane.delete(chapter)
    if (!lanes.drawing.size && !lanes.redrawing.size) lanes.panels = { done: 0, total: 0 }
    publishLanes(lanes)
  }
}

function inRange(range: DrawRange, chapter: MangaChapter): boolean {
  return chapter.number >= range.from && chapter.number <= range.to
}

async function clearFinishedRange(adaptation: Adaptation, chapters: readonly MangaChapter[]): Promise<void> {
  const range = adaptation.drawRange
  if (!range || chapters.some((chapter) => chapter.status !== 'drawn' && inRange(range, chapter))) return
  const latest = (await getAdaptation(adaptation.id))?.drawRange
  if (latest?.from === range.from && latest.to === range.to) await updateAdaptation(adaptation.id, { drawRange: undefined })
}

/** Scripts depend only on the planner's memory, never on each other, so several are written at once. */
const SCRIPTS_AT_ONCE = 3

/**
 * Starts whatever the lanes have room for, and returns the new tasks.
 *
 * Undrawn chapters are taken in order, a draw range first. Up to `chaptersAtOnce`
 * are drawn or redrawn at a time; up to `SCRIPTS_AT_ONCE` scripts are written at a
 * time, in order, for chapters in that window plus `scriptsAhead` more; the planner,
 * one batch at a time because each builds on the last, keeps that many chapters planned.
 */
function schedule(
  settings: AdaptSettings,
  adaptation: Adaptation,
  chapters: readonly MangaChapter[],
  characters: readonly Character[],
  lanes: Lanes,
  signal: AbortSignal,
): Promise<void>[] {
  const started: Promise<void>[] = []
  const undrawn = chapters.filter((chapter) => pending(adaptation, chapter))
  const range = adaptation.drawRange
  const ordered = range
    ? [...undrawn.filter((chapter) => inRange(range, chapter)), ...undrawn.filter((chapter) => !inRange(range, chapter))]
    : undrawn
  const busy = (chapter: MangaChapter) => lanes.drawing.has(chapter.number) || lanes.redrawing.has(chapter.number)
  // A failed chapter holds back everything after it, so the manga never runs ahead of a gap.
  const blockedAt = chapters.find((chapter) => chapter.status === 'stopped')?.number
  const allowed = (chapter: MangaChapter) => blockedAt === undefined || chapter.number < blockedAt
  const full = () => lanes.drawing.size + lanes.redrawing.size >= settings.chaptersAtOnce
  const drawLimit = settings.mode === 'fast' ? 1 : settings.chaptersAtOnce
  const step = (lane: Set<number>, chapter: MangaChapter, run: () => Promise<void>) =>
    inLane(lanes, lane, chapter.number, () => ownFailure(adaptation.id, chapter.number, signal, run))

  for (const chapter of chapters) {
    if (full()) break
    if (!allowed(chapter) || !chapter.redraw.length || !chapter.script || chapter.status === 'stopped' || busy(chapter)) continue
    started.push(step(lanes.redrawing, chapter, () => redrawPages(settings, adaptation, chapter, lanes, signal)))
  }

  // Only the earliest unfinished chapters draw, so a chapter scripted long ago never jumps a gap.
  for (const chapter of ordered.slice(0, drawLimit)) {
    if (full()) break
    if (!allowed(chapter) || !chapter.script || busy(chapter)) continue
    started.push(step(lanes.drawing, chapter, () => drawChapter(settings, adaptation, chapter, lanes, signal)))
  }

  const unscripted = ordered
    .slice(0, settings.chaptersAtOnce + settings.scriptsAhead)
    .filter((chapter) => allowed(chapter) && !chapter.script && !lanes.scripting.has(chapter.number))
  for (const next of unscripted.slice(0, Math.max(0, SCRIPTS_AT_ONCE - lanes.scripting.size))) {
    started.push(step(lanes.scripting, next, () => scriptChapter(settings, adaptation, next, characters, lanes, signal)))
  }

  const wanted = settings.chaptersAtOnce + settings.scriptsAhead
  if (blockedAt !== undefined) return started
  if (!lanes.planning && undrawn.length < wanted && adaptation.readThrough < planLimit(adaptation)) {
    started.push(planNext(settings, adaptation, chapters, lanes, signal))
  }

  if (!lanes.sheets && !undrawn.length && missingSheet(adaptation, chapters, characters)) {
    lanes.sheets = true
    const last = chapters.slice(-1).map((chapter) => chapter.number)
    started.push(
      ensureSheets(settings, adaptation, last, undefined, scriptedPropIds(chapters), scriptedPlaceIds(chapters), lanes, signal)
        .then(() => undefined)
        .finally(() => {
          lanes.sheets = false
        }),
    )
  }

  return started
}

async function planNext(
  settings: AdaptSettings,
  adaptation: Adaptation,
  chapters: readonly MangaChapter[],
  lanes: Lanes,
  signal: AbortSignal,
): Promise<void> {
  lanes.planning = true
  let capture: GenerationCapture | undefined
  try {
    const all = await novelChapters(adaptation, signal)
    const from = adaptation.readThrough
    const to = Math.min(all.length, adaptation.stopAt ?? Infinity, from + settings.readAhead)
    if (to <= from) {
      await updateAdaptation(adaptation.id, { novelChapterCount: all.length, checkedAt: Date.now() })
      return
    }
    lanes.reading = [from + 1, to]
    publishLanes(lanes)

    // The source's own rate limiter paces these.
    const batch: BatchChapter[] = await drainTasks(
      all.slice(from, to).map(async (chapter, offset) => {
        const ref: NovelChapterRef = { index: from + offset + 1, url: chapter.url, name: chapter.name, memo: chapter.memo }
        return { ref, text: await chapterText(adaptation, ref, signal) }
      }),
    )

    const empty = batch.filter(({ text }) => !text)
    const readable = batch.filter(({ text }) => text)
    const cast = await listCharacters(adaptation.id)
    const previous = chapters.at(-1)
    let plan: Plan | undefined
    if (readable.length) {
      capture = await captureGeneration('plan', { adaptationId: adaptation.id, title: adaptation.title, chapter: (previous?.number ?? 0) + 1 })
      plan = await planBatch(settings, adaptation, readable, cast, previous, (previous?.plan ?? 0) + 1, signal, capture.options)
      for (const character of plan.characters) await putCharacter(character)
      await addProps(adaptation.id, plan.props)
      await addPlaces(adaptation.id, plan.places)
      for (const chapter of plan.chapters) await putChapter(chapter)
    }
    const skipped = [...empty.map(({ ref }) => ref.index), ...(plan?.skip ?? [])].sort((a, b) => a - b)
    await deleteTexts(batch.filter(({ ref }) => skipped.includes(ref.index)).map(({ ref }) => textKey(adaptation.id, ref.url)))
    await updateAdaptation(adaptation.id, {
      readThrough: to,
      novelChapterCount: all.length,
      skipped: [...adaptation.skipped, ...skipped],
      ...(empty.length ? { empty: [...(adaptation.empty ?? []), ...empty.map(({ ref }) => ref.index)] } : {}),
      ...(plan ? { memory: plan.memory } : {}),
      checkedAt: Date.now(),
    })
  } finally {
    await capture?.complete()
    lanes.planning = false
    lanes.reading = undefined
    publishLanes(lanes)
  }
}

const sheetFlights = new Map<string, Promise<void>>()

function singleSheet(key: string, run: () => Promise<void>): Promise<void> {
  const existing = sheetFlights.get(key)
  if (existing) return existing
  const task = run().finally(() => sheetFlights.delete(key))
  sheetFlights.set(key, task)
  return task
}

async function drainTasks<T>(tasks: readonly Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(tasks)
  const failed = results.find((result) => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
  return results.map((result) => (result as PromiseFulfilledResult<T>).value)
}


function scriptPropIds(chapter: MangaChapter): string[] {
  return (chapter.script ?? []).flatMap((page) => page.panels.flatMap((panel) => panel.props ?? []))
}

function scriptPlaceIds(chapter: MangaChapter): string[] {
  return (chapter.script ?? []).flatMap((page) => page.panels.flatMap((panel) => (panel.place ? [panel.place] : [])))
}


/**
 * Draws the missing sheets among `lookIds`, or every look when no set is given, plus the
 * props in `propIds` and places in `placeIds`; a variant brings its main look along.
 */
async function ensureSheets(
  settings: AdaptSettings,
  adaptation: Adaptation,
  chapters: number[],
  lookIds: ReadonlySet<string> | undefined,
  propIds: ReadonlySet<string>,
  placeIds: ReadonlySet<string>,
  lanes: Lanes,
  signal: AbortSignal,
): Promise<Character[]> {
  const characters = await listCharacters(adaptation.id)
  const castIds = lookIds && new Set([...lookIds].map((id) => id.split('@')[0]))
  const wanted = (character: Character, look: Character['looks'][number]) =>
    !lookIds || lookIds.has(look.id) || (isMainLook(look) && castIds!.has(character.id))
  const missing = characters.flatMap((character) =>
    character.looks.filter((look) => !look.sheetKey && wanted(character, look)).map((look) => ({ character, look })),
  )
  const stored = await getAdaptation(adaptation.id)
  const props = (stored?.props ?? []).filter((prop) => !prop.sheetKey && propIds.has(prop.id))
  const places = (stored?.places ?? []).filter((place) => !place.sheetKey && placeIds.has(place.id))
  if (!missing.length && !props.length && !places.length) return characters

  const style = styleLine(adaptation.style, adaptation.styleNotes)
  const progress = { chapters, done: 0, total: missing.length + props.length + places.length }
  lanes.cast = progress
  publishLanes(lanes)

  const drawProp = (prop: Prop) => singleSheet(propSheetKey(adaptation.id, prop.id), async () => {
    if ((await getAdaptation(adaptation.id))?.props?.find((item) => item.id === prop.id)?.sheetKey) return
    const capture = await captureGeneration('sheet', { adaptationId: adaptation.id, title: adaptation.title, entityId: prop.id, entityKind: 'prop' })
    try {
    const target = { adaptationId: adaptation.id, kind: 'sheet' as const, name: `${prop.name} · ${prop.kind}`, shot: prop.kind }
    const image = await imageSlots(settings.concurrency, 0, signal, async () => {
      const end = startJob({ ...target, title: adaptation.title, cast: [], operationId: capture.options.context?.operationId })
      try {
        return await drawSheet(settings, propSheetPrompt(style, prop), undefined, prop.name, signal, capture.options)
      } finally {
        end()
      }
    })
    const key = propSheetKey(adaptation.id, prop.id)
    await putBlob(key, image)
    await patchProp(adaptation.id, prop.id, { sheetKey: key })
    progress.done++
    publishLanes(lanes)
    } finally { await capture.complete() }
  })

  const drawPlace = (place: Place) => singleSheet(placeSheetKey(adaptation.id, place.id), async () => {
    if ((await getAdaptation(adaptation.id))?.places?.find((item) => item.id === place.id)?.sheetKey) return
    const capture = await captureGeneration('sheet', { adaptationId: adaptation.id, title: adaptation.title, entityId: place.id, entityKind: 'place' })
    try {
    const target = { adaptationId: adaptation.id, kind: 'sheet' as const, name: `${place.name} · place`, shot: 'place' }
    const image = await imageSlots(settings.concurrency, 0, signal, async () => {
      const end = startJob({ ...target, title: adaptation.title, cast: [], operationId: capture.options.context?.operationId })
      try {
        return await drawSheet(settings, placeSheetPrompt(style, place), undefined, place.name, signal, capture.options)
      } finally {
        end()
      }
    })
    const key = placeSheetKey(adaptation.id, place.id)
    await putBlob(key, image)
    await patchPlace(adaptation.id, place.id, { sheetKey: key })
    progress.done++
    publishLanes(lanes)
    } finally { await capture.complete() }
  })

  const draw = ({ character, look }: (typeof missing)[number]): Promise<void> =>
    singleSheet(sheetKey(adaptation.id, look.id), async () => {
      if (!isMainLook(look)) {
        const main = character.looks.find(isMainLook)
        if (main && !main.sheetKey) await draw({ character, look: main })
      }
      const current = (await listCharacters(adaptation.id)).find((item) => item.id === character.id) ?? character
      if (current.looks.find((item) => item.id === look.id)?.sheetKey) return
      const capture = await captureGeneration('sheet', { adaptationId: adaptation.id, title: adaptation.title, entityId: look.id, entityKind: 'character' })
      try {
      const main = current.looks.find(isMainLook)
      const mainSheet = !isMainLook(look) && main?.sheetKey ? await getBlob(main.sheetKey) : undefined
      const ref = mainSheet ? await downscale(mainSheet) : undefined
      const prompt = sheetPrompt(style, current, look)
      const target = { adaptationId: adaptation.id, kind: 'sheet' as const, name: `${current.name} · ${look.name}`, shot: current.role }
      const image = await imageSlots(settings.concurrency, 0, signal, async () => {
        const end = startJob({ ...target, title: adaptation.title, cast: [current.name], operationId: capture.options.context?.operationId })
        try {
          return await drawSheet(settings, prompt, ref, target.name, signal, capture.options)
        } finally {
          end()
        }
      })

      const key = sheetKey(adaptation.id, look.id)
      await putBlob(key, image)
      await setSheetKey(character.id, look.id, key)
      progress.done++
      publishLanes(lanes)
      } finally { await capture.complete() }
    })

  try {
    await drainTasks([...missing.map(draw), ...props.map(drawProp), ...places.map(drawPlace)])
  } finally {
    lanes.cast = undefined
    publishLanes(lanes)
  }
  return listCharacters(adaptation.id)
}

const SHEET_SIZE = '1536x1024'

const PANEL_KINDS: Record<AdaptStyle, string> = {
  manga: 'manga panel',
  webtoon: 'full-colour webtoon panel, full bleed',
  sketch: 'storyboard panel',
}

const FRAME_SHAPES: Record<Frame, string> = { wide: 'wide', inset: 'wide', close: 'square', tall: 'tall portrait' }

function panelOpener(artStyle: AdaptStyle, frame: Frame | undefined): string {
  return `A single ${FRAME_SHAPES[frame ?? 'wide']} ${PANEL_KINDS[artStyle]}.`
}

/** Tells the image model which side each speaker stands on, so the bubble tail points at them. */
function speakerLines(panel: ScriptPanel, looks: LookIndex): string {
  const characters = [...new Set([...looks.values()].map((entry) => entry.character))]
  const placed = panel.text.flatMap((item) =>
    (item.kind === 'speech' || item.kind === 'thought') && item.speaker && (item.speakerAt === 'left' || item.speakerAt === 'right')
      ? [`${speakerCharacter(characters, item.speaker)?.name ?? item.speaker}, who is ${item.kind === 'speech' ? 'speaking' : 'thinking'}, is on the ${item.speakerAt} of the frame.`]
      : [],
  )
  return [...new Set(placed)].join(' ')
}

const SAFE_NOTE = '\nAll-ages scene: everyone fully clothed in modest everyday wear, relaxed neutral poses, no emphasis on bodies, no blood.'

/** A blocked sheet is redrawn once from a toned-down rewrite before the chapter stops on it. */
async function drawSheet(
  settings: AdaptSettings,
  prompt: string,
  ref: Blob | undefined,
  subject: string,
  signal: AbortSignal,
  options: JournalOptions,
): Promise<Blob> {
  prompt = (options.context?.target && await savedGenerationPrompt(options.context.target)) || prompt
  const draw = (text: string) =>
    ref
      ? editImage(settings, settings.imageModel, text, [ref], SHEET_SIZE, signal, options)
      : generateImage(settings, settings.imageModel, text, SHEET_SIZE, signal, options)
  try {
    return await draw(prompt)
  } catch (cause) {
    if (!isModerationBlocked(cause)) throw cause
  }
  const clean = await cleanImagePrompt(settings, prompt, signal, options)
  try {
    return await draw((clean ?? prompt) + SAFE_NOTE)
  } catch (cause) {
    if (!isModerationBlocked(cause)) throw cause
    const { message, status } = cause as AdaptApiError
    throw new AdaptApiError(message, status, SHEET_BLOCKED, subject)
  }
}

const REFERENCE_NOTE =
  " Use character sheets only for each character's face, hair, outfit and carried items, and design sheets only for each prop's shape, colours and details. Do not copy their poses, backgrounds, lighting, framing or layout. Draw everyone and everything inside the scene at the panel's own scale and angle. Logos, badges, markings and patterns stay fixed to the surface they are on, in the same position and direction as on the sheet, and turn and foreshorten with that object. Keep one consistent perspective and light source, in contact with what they sit on, hold or lean against."

type LookIndex = ReturnType<typeof lookIndex>

interface Reference {
  label: string
  key: string
}

interface Designs {
  props: ReadonlyMap<string, Prop>
  places: ReadonlyMap<string, Place>
}

function designsOf(adaptation: Adaptation | undefined): Designs {
  return {
    props: new Map((adaptation?.props ?? []).map((prop) => [prop.id, prop])),
    places: new Map((adaptation?.places ?? []).map((place) => [place.id, place])),
  }
}

/** Character sheets first, then the panel's place, then its props in script order, for every sheet already drawn. */
function panelReferences(panel: ScriptPanel, index: LookIndex, designs: Designs): Reference[] {
  const looks = panel.looks.flatMap((id) => {
    const entry = index.get(id)
    return entry?.look.sheetKey ? [{ label: `the sheet for ${entry.character.name} (${entry.look.name})`, key: entry.look.sheetKey }] : []
  })
  const place = panel.place ? designs.places.get(panel.place) : undefined
  const setting = place?.sheetKey ? [{ label: `the design sheet for the place ${place.name}`, key: place.sheetKey }] : []
  const shown = (panel.props ?? []).flatMap((id) => {
    const prop = designs.props.get(id)
    return prop?.sheetKey ? [{ label: `the design sheet for ${prop.name}`, key: prop.sheetKey }] : []
  })
  return [...looks.slice(0, MAX_LOOK_REFS), ...setting, ...shown].slice(0, MAX_REFS)
}

function panelPrompt(
  artStyle: AdaptStyle,
  style: string,
  panel: ScriptPanel,
  looks: LookIndex,
  designs: Designs,
  refs: readonly Reference[],
  note?: string,
): string {
  const cast = panel.looks.flatMap((id) => (looks.has(id) ? [looks.get(id)!] : []))
  const refNotes = refs.map((ref, index) => `Reference image ${index + 1} is ${ref.label}.`).join(' ')
  const place = panel.place ? designs.places.get(panel.place) : undefined
  const shown = (panel.props ?? []).flatMap((id) => designs.props.get(id) ?? [])
  const designLines = [...(place ? [place] : []), ...shown].map((item) => `${item.name}: ${item.description}`).join('\n')
  const anchors = { tl: 'top left', tr: 'top right', bl: 'bottom left', br: 'bottom right' } as const
  const space = panel.text.map((item) => anchors[item.anchor]).join(' and ') || 'edges'
  const speakers = speakerLines(panel, looks)
  const where = `${place ? `${place.name}. ` : ''}${panel.shot}${panel.camera ? `, camera ${panel.camera}` : ''}`
  return `${panelOpener(artStyle, panel.frame)} ${style}
Scene: ${where}. ${panel.prompt}${speakers ? `\n${speakers}` : ''}${note ? `\nChange requested: ${note}` : ''}
${designLines ? `Draw these exactly as described, the same in every panel:\n${designLines}\n` : ''}${refNotes}${refNotes ? REFERENCE_NOTE : ''}
${cast.map(({ character, look }) => `${character.name}: ${lookAppearance(character, look)}`).join('\n')}
Keep every face, head and body out of the ${space} of the frame: that area is reserved for lettering and shows only background such as sky, wall, floor or ground. Frame the characters so they stay whole and clearly visible in the rest of the panel. No text, no speech bubbles, no captions, no sound effects, no logos, no brand names, no lettering on screens, signs or vehicles, no panel borders, no watermark.`
}

/** A backend that takes one image rejects the request and says so; other 4xx replies are not retried with a contact sheet. */
function refusedImageCount(cause: unknown): boolean {
  if (!(cause instanceof AdaptApiError) || isModerationBlocked(cause)) return false
  return (cause.status === 400 || cause.status === 413 || cause.status === 422) && /image/i.test(cause.message)
}

function promptBlocked(cause: unknown): AdaptApiError {
  const { message, status } = cause as AdaptApiError
  return new AdaptApiError(message, status, PROMPT_BLOCKED)
}

async function drawPanel(
  settings: AdaptSettings,
  prompt: string,
  refs: readonly Blob[],
  size: string,
  job: Omit<LiveJob, 'id' | 'startedAt'> & { chapter: number },
  signal: AbortSignal,
  options: JournalOptions,
): Promise<Blob> {
  prompt = (options.context?.target && await savedGenerationPrompt(options.context.target)) || prompt
  return imageSlots(settings.concurrency, job.chapter + (job.page ?? 0) / 10000, signal, async () => {
    const end = startJob({ ...job, operationId: options.context?.operationId })
    const draw = async (text: string) => {
      if (!refs.length) return await generateImage(settings, settings.imageModel, text, size, signal, options)
      try {
        return await editImage(settings, settings.imageModel, text, refs, size, signal, options)
      } catch (cause) {
        if (refs.length < 2 || !refusedImageCount(cause)) throw cause
        return await editImage(settings, settings.imageModel, text, [await contactSheet(refs)], size, signal, options)
      }
    }
    try {
      try {
        return await draw(prompt)
      } catch (cause) {
        if (!isModerationBlocked(cause)) throw cause
      }
      let blocked: unknown
      try {
        return await draw(prompt + SAFE_NOTE)
      } catch (cause) {
        if (!isModerationBlocked(cause)) throw cause
        blocked = cause
      }
      const clean = await cleanImagePrompt(settings, prompt, signal, options)
      if (!clean) throw promptBlocked(blocked)
      try {
        return await draw(clean + SAFE_NOTE)
      } catch (cause) {
        if (!isModerationBlocked(cause)) throw cause
        if (!refs.length) throw promptBlocked(cause)
      }
      // The filter also judges the reference sheets, so a revealing outfit sheet blocks every panel that uses it.
      try {
        return await generateImage(settings, settings.imageModel, clean + SAFE_NOTE, size, signal, options)
      } catch (cause) {
        throw isModerationBlocked(cause) ? promptBlocked(cause) : cause
      }
    } finally {
      end()
    }
  })
}

/** The name tag for each speaker's first line in the chapter, keyed `page:panel:item`, so a redrawn page still tags correctly. */
function nameTags(script: readonly ScriptPage[], characters: readonly Character[]): Map<string, string> {
  const seen = new Set<string>()
  const tags = new Map<string, string>()
  script.forEach((page, pageIndex) =>
    page.panels.forEach((panel, panelIndex) =>
      panel.text.forEach((item, itemIndex) => {
        if ((item.kind !== 'speech' && item.kind !== 'thought') || !item.speaker?.trim()) return
        const name = speakerCharacter(characters, item.speaker)?.name ?? item.speaker.trim()
        if (seen.has(name)) return
        seen.add(name)
        tags.set(`${pageIndex + 1}:${panelIndex + 1}:${itemIndex}`, firstName(name))
      }),
    ),
  )
  return tags
}

function lookIndex(characters: readonly Character[]) {
  return new Map(characters.flatMap((character) => character.looks.map((look) => [look.id, { character, look }] as const)))
}

/** Drops references whose blob is gone, so the numbered lines always match the images sent. */
function referenceLoader() {
  // Promises are cached so panels starting together downscale each sheet once.
  const cache = new Map<string, Promise<Blob | undefined>>()
  const load = async (key: string) => {
    const sheet = await getBlob(key)
    return sheet ? downscale(sheet) : undefined
  }
  return async (wanted: readonly Reference[]): Promise<{ refs: Reference[]; blobs: Blob[] }> => {
    const refs: Reference[] = []
    const blobs: Blob[] = []
    for (const ref of wanted) {
      if (!cache.has(ref.key)) cache.set(ref.key, load(ref.key))
      const blob = await cache.get(ref.key)
      if (!blob) continue
      refs.push(ref)
      blobs.push(blob)
    }
    return { refs, blobs }
  }
}

/** The check's verdict for a panel, or null when the check could not run and the panel stands as drawn. */
async function checkDrawn(
  settings: AdaptSettings,
  panel: ScriptPanel,
  cast: readonly string[],
  image: Blob,
  refs: readonly Reference[],
  blobs: readonly Blob[],
  signal: AbortSignal,
  options: JournalOptions,
): Promise<CheckResult | null> {
  try {
    return await checkPanel(settings, panel, cast, image, refs.map((ref, index) => ({ label: ref.label, blob: blobs[index] })), signal, options)
  } catch (cause) {
    if (fatal(cause, signal)) throw cause
    return null
  }
}


/** Letters one page from its stored panels; throws when a panel is missing. */
async function composeStoredPage(
  adaptationId: string,
  chapterNumber: number,
  script: readonly ScriptPage[],
  page: number,
  tags: ReadonlyMap<string, string>,
): Promise<void> {
  const scriptPage = script[page - 1]
  const images: StripPanel[] = []
  for (const [panelIndex, panel] of scriptPage.panels.entries()) {
    const image = await getBlob(panelKey(adaptationId, chapterNumber, page, panelIndex + 1))
    if (!image) throw new Error(`Panel ${panelIndex + 1} of page ${page} is missing.`)
    images.push({
      image,
      text: panel.text.map((item, itemIndex) => ({ ...item, tag: tags.get(`${page}:${panelIndex + 1}:${itemIndex}`) })),
      frame: panel.frame ?? 'wide',
      gapAfter: panel.gapAfter,
      align: panel.align,
    })
  }
  const composed =
    scriptPage.layout === 'strip'
      ? await composeStrip(scriptPage.tone ?? 'light', images)
      : await composePage(scriptPage.layout, images)
  await putBlob(pageKey(adaptationId, chapterNumber, page), composed)
}

/** Panels in work at once; each reads the whole generation state, so a long chapter must never start them all together. */
const panelSlots = createSlots()

/** Draws the panels of `pages` not stored yet, with `notes` keyed by `panelId`, then letters each page. */
async function drawPages(
  settings: AdaptSettings,
  adaptation: Adaptation,
  chapter: MangaChapter,
  pages: readonly number[],
  notes: ReadonlyMap<string, string>,
  characters: readonly Character[],
  lanes: Lanes,
  saveProgress: boolean,
  redrawIds: ReadonlyMap<string, string>,
  signal: AbortSignal,
): Promise<void> {
  const script = chapter.script!
  const style = styleLine(adaptation.style, adaptation.styleNotes)
  const loadRefs = referenceLoader()
  const tags = nameTags(script, characters)
  let composedPanels = script.reduce((sum, page, index) => sum + (pages.includes(index + 1) ? 0 : page.panels.length), 0)
  let progressWrites = Promise.resolve()
  lanes.panels.total += pages.reduce((sum, page) => sum + script[page - 1].panels.length, 0)
  publishLanes(lanes)
  await drainTasks(pages.map(async (page) => {
    await drainTasks(script[page - 1].panels.map((panel, panelIndex) => panelSlots(settings.concurrency * 2, chapter.number + page / 10000, signal, async () => {
      signal.throwIfAborted()
      const number = panelIndex + 1
      const id = panelId(page, number)
      const key = panelKey(adaptation.id, chapter.number, page, number)
      let image = await getBlob(key)
      const redrawId = redrawIds.get(id)
      if (redrawId && panel.check?.redrawId !== redrawId) image = undefined
      const needsCheck = adaptation.checkPanels && (!panel.check || panel.check.status === 'disabled' || panel.check.status === 'pending' || panel.check.status === 'unchecked')
      if (image && !needsCheck) {
        markPanelDrawn(adaptation.id, chapter.number, page, number)
        lanes.panels.done++
        publishLanes(lanes)
        return
      }
      const ready = await ensureSheets(
        settings, adaptation, [chapter.number], new Set(panel.looks),
        new Set(panel.props ?? []), new Set(panel.place ? [panel.place] : []), lanes, signal,
      )
      signal.throwIfAborted()
      const index = lookIndex(ready)
      const designs = designsOf(await getAdaptation(adaptation.id))
      const cast = [...new Set(panel.looks.flatMap((look) => index.get(look)?.character.name ?? []))]
      const wearing = panel.looks.flatMap((id) => {
        const entry = index.get(id)
        return entry ? [`${entry.character.name} in the ${entry.look.name} look${entry.look.change ? ` (${entry.look.change})` : ''}`] : []
      })
      const { refs, blobs } = await loadRefs(panelReferences(panel, index, designs))
      const target = { adaptationId: adaptation.id, kind: 'panel' as const, chapter: chapter.number, page, panel: number, shot: panel.shot }
      const generationTarget: GenerationTarget = { adaptationId: adaptation.id, title: adaptation.title, chapter: chapter.number, page, panel: number }
      let tries = image ? (panel.check?.tries ?? 0) : 0
      const saveCheck = (check: PanelCheck) => patchPanelChecks(adaptation.id, chapter.number, new Map([[id, { ...check, redrawId }]]))
      const draw = async (note?: string) => {
        const capture = await captureGeneration('panel', generationTarget)
        try {
        const blob = await drawPanel(
          settings, panelPrompt(adaptation.style, style, panel, index, designs, refs, note),
          blobs, IMAGE_SIZES[panel.frame ?? 'wide'], { ...target, title: adaptation.title, cast }, signal, capture.options,
        )
        await putPanelImage(adaptation.id, chapter.number, page, number, blob, {
          status: adaptation.checkPanels ? 'pending' : 'disabled', tries, redrawId,
        })
        return blob
        } finally { await capture.complete() }
      }
      if (!image) image = await draw(notes.get(id))
      if (adaptation.checkPanels) {
        for (;;) {
          signal.throwIfAborted()
          const capture = await captureGeneration('check', generationTarget)
          try {
          const result = await checkDrawn(settings, panel, wearing, image, refs, blobs, signal, capture.options)
          if (!result) {
            await saveCheck({ status: 'unchecked', tries })
            break
          }
          if (result.ok || tries >= MAX_CHECK_REDRAWS) {
            await saveCheck({ status: result.ok ? 'passed' : 'flagged', issue: result.issue, tries })
            break
          }
          tries++
          await capture.complete()
          image = await draw([notes.get(id), result.issue].filter(Boolean).join('. '))
          } finally { await capture.complete() }
        }
      }
      markPanelDrawn(adaptation.id, chapter.number, page, number)
      lanes.panels.done++
      publishLanes(lanes)
    })))
    signal.throwIfAborted()
    await composeStoredPage(adaptation.id, chapter.number, script, page, tags)
    markPageComposed(adaptation.id, chapter.number, page)
    if (saveProgress) {
      composedPanels += script[page - 1].panels.length
      const panelsDone = composedPanels
      progressWrites = progressWrites.then(async () => {
        await updateChapter(adaptation.id, chapter.number, { panelsDone })
      })
      await progressWrites
    }
  }))
}

/** Drops a chapter's pages and panels, which no longer match once its script changes. */
async function dropChapterImages(adaptationId: string, chapterNumber: number): Promise<void> {
  for (const page of await listPageKeys(adaptationId, chapterNumber)) await deleteBlob(pageKey(adaptationId, chapterNumber, page))
  for (const id of await listPanelKeys(adaptationId, chapterNumber)) {
    const [page, panel] = id.split('-').map(Number)
    await deleteBlob(panelKey(adaptationId, chapterNumber, page, panel))
  }
  clearChapterProgress(adaptationId, chapterNumber)
  queryClient?.removeQueries({ queryKey: ['adapt', 'pages', adaptationId, chapterNumber] })
  queryClient?.removeQueries({ queryKey: ['adapt', 'panels', adaptationId, chapterNumber] })
}

/** Beats first, saved so a failed storyboard never pays for them twice; leaves the chapter `queued`. */
async function scriptChapter(
  settings: AdaptSettings,
  adaptation: Adaptation,
  chapter: MangaChapter,
  characters: readonly Character[],
  lanes: Lanes,
  signal: AbortSignal,
): Promise<void> {
  // Read fresh: the planner may have added props, places and memory since this adaptation was loaded.
  const fresh = (await getAdaptation(adaptation.id)) ?? adaptation
  const places = fresh.places ?? []
  const earliest = Math.min(...chapter.novelChapters.map((ref) => ref.index))
  const memory = chapter.contextMemory !== undefined
    ? chapter.contextMemory ?? undefined
    : fresh.memory && fresh.memory.updatedThrough < earliest ? fresh.memory : undefined
  const stage = (value: 'beats' | 'script') => {
    lanes.text[chapter.number] = { stage: value, startedAt: Date.now(), attempt: 1, model: settings.scriptModel }
    publishLanes(lanes)
  }
  const onAttempt = (event: { attempt: number; model: string; reason?: string }) => {
    lanes.text[chapter.number] = { ...lanes.text[chapter.number], ...event }
    publishLanes(lanes)
  }
  const onSection = ({ index, total }: { index: number; total: number }) => {
    lanes.text[chapter.number] = { ...lanes.text[chapter.number], attempt: 1, reason: undefined, part: { index, total } }
    publishLanes(lanes)
  }
  const sheets: Promise<unknown>[] = []
  const prefetch = (lookIds: Iterable<string>, propIds: Iterable<string>, placeIds: Iterable<string>) => {
    sheets.push(ensureSheets(settings, adaptation, [chapter.number], new Set(lookIds), new Set(propIds), new Set(placeIds), lanes, signal))
  }
  let capture: GenerationCapture | undefined
  try {
    let beats = chapter.beats
    if (!beats) {
      stage('beats')
      const texts = (await drainTasks(
        chapter.novelChapters.map(async (ref) => {
          const text = sourcePart(await chapterText(adaptation, ref, signal), ref.part)
          return text ? `Novel chapter ${ref.index}: ${ref.name}${ref.part ? `, part ${ref.part.index} of ${ref.part.total}` : ''}\n${text}` : ''
        }),
      )).filter(Boolean)
      if (!texts.length) throw new Error('The novel text for this chapter is empty. Check the chapter on its source, then retry.')
      capture = await captureGeneration('beats', { adaptationId: adaptation.id, title: adaptation.title, chapter: chapter.number })
      const written = await writeBeats(settings, texts.join('\n\n'), memory, characters, places, signal, {
        ...capture.options,
        onAttempt,
        onSection,
        parts: chapter.beatParts,
        onPart: async (part, done) => {
          prefetch(part.beats.flatMap((beat) => beat.cast), [], [])
          await updateChapter(adaptation.id, chapter.number, { beatParts: [...done] })
        },
      })
      beats = written.beats
      await updateChapter(adaptation.id, chapter.number, { beats, cut: written.cut, scriptParts: undefined })
      await capture.complete()
    }
    stage('script')
    capture = await captureGeneration('script', { adaptationId: adaptation.id, title: adaptation.title, chapter: chapter.number })
    const script = await writeScript(
      settings,
      { beats, memory, characters, props: fresh.props ?? [], places, style: fresh.style, note: chapter.scriptNote, wearing: knownWearing(chapter.wearing, characters) },
      signal,
      {
        ...capture.options,
        onAttempt,
        onSection,
        parts: chapter.beats ? chapter.scriptParts : undefined,
        onPart: async (part, done) => {
          const panels = part.pages.flatMap((page) => page.panels)
          prefetch(panels.flatMap((panel) => panel.looks), panels.flatMap((panel) => panel.props ?? []), panels.flatMap((panel) => (panel.place ? [panel.place] : [])))
          await updateChapter(adaptation.id, chapter.number, { scriptParts: [...done] })
        },
      },
    )
    await dropChapterImages(adaptation.id, chapter.number)
    await updateChapter(adaptation.id, chapter.number, {
      script,
      scriptNote: undefined,
      pageCount: 0,
      panelsDone: 0,
      panelsTotal: script.reduce((sum, page) => sum + page.panels.length, 0),
    })
  } finally {
    delete lanes.text[chapter.number]
    publishLanes(lanes)
    await Promise.allSettled(sheets)
    await capture?.complete()
  }
}


async function drawChapter(
  settings: AdaptSettings,
  adaptation: Adaptation,
  chapter: MangaChapter,
  lanes: Lanes,
  signal: AbortSignal,
): Promise<void> {
  const ready =
    chapter.status === 'drawing'
      ? chapter
      : await updateChapter(adaptation.id, chapter.number, { status: 'drawing', error: null })
  if (!ready) return
  const characters = await listCharacters(adaptation.id)
  await finishChapter(settings, adaptation, ready, characters, lanes, signal)
}

async function finishChapter(
  settings: AdaptSettings,
  adaptation: Adaptation,
  chapter: MangaChapter,
  characters: readonly Character[],
  lanes: Lanes,
  signal: AbortSignal,
): Promise<void> {
  const composed = new Set(await listPageKeys(adaptation.id, chapter.number))
  const pages: number[] = []
  for (let page = 1; page <= chapter.script!.length; page++) {
    if (!composed.has(page)) pages.push(page)
  }
  await drawPages(settings, adaptation, chapter, pages, new Map(), characters, lanes, true, new Map(), signal)

  await updateChapter(adaptation.id, chapter.number, {
    status: 'drawn',
    pageCount: chapter.script!.length,
    drawnAt: Date.now(),
    error: null,
  })
  const pending = (await listChapters(adaptation.id)).filter((other) => other.number !== chapter.number && other.status !== 'drawn')
  const needed = new Set(pending.flatMap((other) => other.novelChapters.map((ref) => ref.url)))
  await deleteTexts(chapter.novelChapters.filter((ref) => !needed.has(ref.url)).map((ref) => textKey(adaptation.id, ref.url)))
  await publishInOrder(adaptation.id)
}

async function redrawPages(
  settings: AdaptSettings,
  adaptation: Adaptation,
  chapter: MangaChapter,
  lanes: Lanes,
  signal: AbortSignal,
): Promise<void> {
  const characters = await listCharacters(adaptation.id)
  const redraw = chapter.redraw.map((request) => ({ ...request, id: request.id ?? ulid() }))
  await updateChapter(adaptation.id, chapter.number, { redraw })
  const requests = redraw.filter((request) => chapter.script![request.page - 1])
  const notes = new Map<string, string>()
  const redrawIds = new Map<string, string>()
  for (const request of requests) {
    const panels = chapter.script![request.page - 1].panels
    const numbers = request.panel ? [request.panel] : panels.map((_, panelIndex) => panelIndex + 1)
    for (const number of numbers) {
      notes.set(panelId(request.page, number), request.note)
      redrawIds.set(panelId(request.page, number), request.id)
    }
  }
  const pages = [...new Set(requests.map((request) => request.page))]
  await drawPages(settings, adaptation, chapter, pages, notes, characters, lanes, false, redrawIds, signal)
  const latest = await getChapter(adaptation.id, chapter.number)
  await updateChapter(adaptation.id, chapter.number, {
    redraw: (latest?.redraw ?? []).filter(
      (item) => !requests.some((done) => done.id === item.id),
    ),
  })
  queryClient?.removeQueries({ queryKey: ['reader', 'pages', ADAPTED_SOURCE_ID, adaptation.id] })
}

let publishChain: Promise<void> = Promise.resolve()

/** Chapters finishing together would otherwise upsert the same manga row at once. */
function publishInOrder(adaptationId: string): Promise<void> {
  const run = publishChain.then(() => publish(adaptationId))
  publishChain = run.catch(() => undefined)
  return run
}

async function publish(adaptationId: string): Promise<void> {
  const adaptation = await getAdaptation(adaptationId)
  if (!adaptation) return
  const row = await upsertManga(ADAPTED_SOURCE_ID, await adaptedSeries(adaptation))
  await upsertChapters(row.id, await adaptedChapters(adaptationId))
  if (row.favorite) await setFavorite(row.id, false)
  void queryClient?.invalidateQueries({ queryKey: ['db'] })
  void queryClient?.invalidateQueries({ queryKey: ['browse', ADAPTED_SOURCE_ID] })
  void queryClient?.invalidateQueries({ queryKey: ['manga', ADAPTED_SOURCE_ID] })
}

// ----------------------------------------------------------------- actions --

export interface StartChoices {
  style: AdaptStyle
  styleNotes: string
  /** Last novel chapter to adapt; unset reads to the end. */
  stopAt: number | undefined
  skipPrologue: boolean
  checkPanels: boolean
}

export async function createAdaptation(sourceId: string, novel: SManga, chapterCount: number, choices: StartChoices): Promise<Adaptation> {
  if (!(await readAdaptSettings()).endpoint) throw new AdaptApiError(MISSING_ENDPOINT, 0)
  const adaptation: Adaptation = {
    id: ulid().toLowerCase(),
    sourceId,
    novelUrl: novel.url,
    novelMemo: novel.memo,
    title: novel.title,
    author: novel.author,
    thumbnailUrl: novel.thumbnailUrl,
    style: choices.style,
    styleNotes: choices.styleNotes.trim(),
    novelChapterCount: chapterCount,
    readThrough: 0,
    skipped: [],
    stopAt: choices.stopAt,
    skipPrologue: choices.skipPrologue,
    checkPanels: choices.checkPanels,
    status: 'active',
    error: null,
    checkedAt: Date.now(),
    createdAt: Date.now(),
    bytes: 0,
  }
  await putAdaptation(adaptation)
  nudgeAdaptationRunner()
  return adaptation
}

export async function pauseAdaptation(adaptationId: string): Promise<void> {
  await updateAdaptation(adaptationId, { status: 'paused' })
  interruptIf(adaptationId)
}

export async function stopAdaptation(adaptationId: string): Promise<void> {
  await pauseAdaptation(adaptationId)
  await workerTasks.get(adaptationId)?.catch(() => undefined)
  await updateAdaptation(adaptationId, { status: 'stopped', error: null })
  clearActivity(adaptationId)
}

export async function resumeAdaptation(adaptationId: string): Promise<void> {
  if (replacementLocks.has(adaptationId) || await hasPendingGenerationApplication(adaptationId)) throw new Error('Finish the pending generation replacement before resuming this adaptation.')
  for (const chapter of await listChapters(adaptationId)) {
    if (chapter.status === 'stopped') await updateChapter(adaptationId, chapter.number, { status: 'queued', error: null })
  }
  await updateAdaptation(adaptationId, { status: 'active', error: null })
  nudgeAdaptationRunner()
}

export async function setDrawRange(adaptationId: string, range: DrawRange | undefined): Promise<void> {
  let drawRange: DrawRange | undefined
  if (range) {
    const planned = (await listChapters(adaptationId)).at(-1)?.number ?? 0
    if (!planned) return
    const clamp = (value: number) => Math.min(planned, Math.max(1, Math.round(value)))
    const [from, to] = [clamp(range.from), clamp(range.to)].sort((a, b) => a - b)
    drawRange = { from, to }
  }
  await updateAdaptation(adaptationId, { drawRange })
  // The current batch stops so the range starts now; panels already saved are kept.
  interruptIf(adaptationId)
  nudgeAdaptationRunner()
}

export async function setStopAt(adaptationId: string, stopAt: number | undefined): Promise<void> {
  if (stopAt !== undefined && (!Number.isInteger(stopAt) || stopAt < 1)) {
    throw new Error('The stop point must be a whole chapter number.')
  }
  await updateAdaptation(adaptationId, { stopAt })
  nudgeAdaptationRunner()
}

/** Queues a whole page; it replaces any panel requests on that page. */
export async function requestRedraw(adaptationId: string, chapterNumber: number, page: number, note: string): Promise<void> {
  const chapter = await getChapter(adaptationId, chapterNumber)
  if (!chapter) return
  const redraw = [...chapter.redraw.filter((item) => item.page !== page), { id: ulid(), page, note: note.trim() }]
  await updateChapter(adaptationId, chapterNumber, { redraw })
  nudgeAdaptationRunner()
}

/** Queues one panel, unless its whole page is already queued. */
export async function requestPanelRedraw(
  adaptationId: string,
  chapterNumber: number,
  page: number,
  panel: number,
  note: string,
): Promise<void> {
  const chapter = await getChapter(adaptationId, chapterNumber)
  if (!chapter || chapter.redraw.some((item) => item.page === page && item.panel === undefined)) return
  const redraw = [...chapter.redraw.filter((item) => item.page !== page || item.panel !== panel), { id: ulid(), page, panel, note: note.trim() }]
  await updateChapter(adaptationId, chapterNumber, { redraw })
  nudgeAdaptationRunner()
}

function withPanel(script: readonly ScriptPage[], page: number, panel: number, edit: (panel: ScriptPanel) => ScriptPanel): ScriptPage[] {
  return script.map((item, pageIndex) =>
    pageIndex + 1 === page ? { ...item, panels: item.panels.map((entry, panelIndex) => (panelIndex + 1 === panel ? edit(entry) : entry)) } : item,
  )
}

/** Marks a flagged panel as fine as drawn, so it leaves the list to check. */
export async function keepPanel(adaptationId: string, chapterNumber: number, page: number, panel: number): Promise<void> {
  const chapter = await getChapter(adaptationId, chapterNumber)
  if (!chapter?.script) return
  const entry = chapter.script[page - 1]?.panels[panel - 1]
  if (!entry) return
  await patchPanelChecks(adaptationId, chapterNumber, new Map([[panelId(page, panel), {
    ...entry.check, status: 'kept', tries: entry.check?.tries ?? 0,
  }]]))
}

/**
 * Saves a panel's lines and re-letters its page from the stored panels. A page drawn before
 * panels were kept has nothing to re-letter from, so it is queued for a redraw instead.
 * Resolves `'relettered'` or `'redrawing'`.
 */
export async function updatePanelText(
  adaptationId: string,
  chapterNumber: number,
  page: number,
  panel: number,
  text: readonly TextItem[],
): Promise<'relettered' | 'redrawing'> {
  const chapter = await getChapter(adaptationId, chapterNumber)
  if (!chapter?.script?.[page - 1]) throw new Error('This page is not in the script any more.')
  const script = withPanel(chapter.script, page, panel, (entry) => ({
    ...entry,
    text: text.map((item) => ({ ...item, line: item.line.trim() })).filter((item) => item.line),
  }))
  await updateChapter(adaptationId, chapterNumber, { script })
  const stored = new Set(await listPanelKeys(adaptationId, chapterNumber))
  const complete = script[page - 1].panels.every((_, panelIndex) => stored.has(panelId(page, panelIndex + 1)))
  if (!complete) {
    await requestRedraw(adaptationId, chapterNumber, page, '')
    return 'redrawing'
  }
  const characters = await listCharacters(adaptationId)
  await composeStoredPage(adaptationId, chapterNumber, script, page, nameTags(script, characters))
  queryClient?.removeQueries({ queryKey: ['reader', 'pages', ADAPTED_SOURCE_ID, adaptationId] })
  return 'relettered'
}

/** Drops the script so the chapter is storyboarded again from its beats with your note, then redrawn. */
export async function rewriteScript(adaptationId: string, chapterNumber: number, note: string): Promise<void> {
  interruptIf(adaptationId)
  await updateChapter(adaptationId, chapterNumber, {
    script: null,
    scriptParts: undefined,
    scriptNote: note.trim() || undefined,
    status: 'queued',
    drawnAt: null,
    pageCount: 0,
    panelsDone: 0,
    panelsTotal: 0,
    redraw: [],
    error: null,
  })
  nudgeAdaptationRunner()
}

/** The chapter's outfits that still name a look of their own character, so the storyboard is never held to a look it cannot use. */
function knownWearing(wearing: MangaChapter['wearing'], characters: readonly Character[]): Record<string, string> | undefined {
  const known = Object.entries(wearing ?? {}).filter(([characterId, lookId]) =>
    characters.some((character) => character.id === characterId && character.looks.some((look) => look.id === lookId)),
  )
  return known.length ? Object.fromEntries(known) : undefined
}

/**
 * Sets the look a character wears for a whole chapter, or clears it with null so the storyboard picks again.
 * A storyboard already written swaps the character's other looks for this one, and every panel that changes is queued for a redraw.
 */
export async function setChapterOutfit(adaptationId: string, chapterNumber: number, characterId: string, lookId: string | null): Promise<void> {
  const chapter = await getChapter(adaptationId, chapterNumber)
  if (!chapter) return
  const wearing = { ...chapter.wearing }
  if (lookId) wearing[characterId] = lookId
  else delete wearing[characterId]
  const owner = `${characterId}@`
  const swap = (panel: ScriptPanel): ScriptPanel =>
    lookId && panel.looks.some((id) => id.startsWith(owner) && id !== lookId)
      ? { ...panel, looks: [...new Set(panel.looks.map((id) => (id.startsWith(owner) ? lookId : id)))] }
      : panel
  const swapPages = (pages: readonly ScriptPage[]): ScriptPage[] => pages.map((page) => ({ ...page, panels: page.panels.map(swap) }))
  const script = chapter.script ? swapPages(chapter.script) : null
  const redraw = [...chapter.redraw]
  script?.forEach((page, pageIndex) =>
    page.panels.forEach((panel, panelIndex) => {
      const number = panelIndex + 1
      if (panel === chapter.script![pageIndex].panels[panelIndex]) return
      if (redraw.some((item) => item.page === pageIndex + 1 && (item.panel === undefined || item.panel === number))) return
      redraw.push({ id: ulid(), page: pageIndex + 1, panel: number, note: '' })
    }),
  )
  const scriptParts = chapter.scriptParts?.map((part) => ({ ...part, pages: swapPages(part.pages) }))
  if (redraw.length !== chapter.redraw.length || scriptParts) interruptIf(adaptationId)
  await updateChapter(adaptationId, chapterNumber, {
    wearing: Object.keys(wearing).length ? wearing : undefined,
    script,
    scriptParts,
    redraw,
  })
  nudgeAdaptationRunner()
}

export async function updateCharacter(character: Character, redrawLookIds: readonly string[]): Promise<void> {
  const keys = character.looks.filter((look) => redrawLookIds.includes(look.id) && look.sheetKey).map((look) => look.sheetKey!)
  await putCharacter({
    ...character,
    looks: character.looks.map((look) => (redrawLookIds.includes(look.id) ? { ...look, sheetKey: null } : look)),
  })
  for (const key of keys) await deleteBlob(key)
  nudgeAdaptationRunner()
}

/** Saves the description; a redraw drops the sheet so the next chapter that shows the prop draws it again. */
export async function updateProp(adaptationId: string, prop: Prop, redraw: boolean): Promise<void> {
  await patchProp(adaptationId, prop.id, { description: prop.description, ...(redraw ? { sheetKey: undefined } : {}) })
  if (redraw && prop.sheetKey) await deleteBlob(prop.sheetKey)
  nudgeAdaptationRunner()
}

/** Same as `updateProp`, for a place. */
export async function updatePlace(adaptationId: string, place: Place, redraw: boolean): Promise<void> {
  await patchPlace(adaptationId, place.id, { description: place.description, ...(redraw ? { sheetKey: undefined } : {}) })
  if (redraw && place.sheetKey) await deleteBlob(place.sheetKey)
  nudgeAdaptationRunner()
}

/** `'new'`: chapters not drawn yet. `'all'`: every sheet and drawn chapter. A number: drawn chapters from that one on. */
export type StyleScope = 'new' | 'all' | number

/** Saves the style and queues the redraws its scope asks for; storyboards are kept. */
export async function applyStyle(adaptationId: string, style: AdaptStyle, styleNotes: string, scope: StyleScope): Promise<void> {
  await updateAdaptation(adaptationId, { style, styleNotes: styleNotes.trim() })
  if (scope === 'new') return
  if (scope === 'all') {
    const adaptation = await getAdaptation(adaptationId)
    for (const character of await listCharacters(adaptationId)) await updateCharacter(character, character.looks.map((look) => look.id))
    for (const prop of adaptation?.props ?? []) if (prop.sheetKey) await updateProp(adaptationId, prop, true)
    for (const place of adaptation?.places ?? []) if (place.sheetKey) await updatePlace(adaptationId, place, true)
  }
  const from = scope === 'all' ? 1 : scope
  for (const chapter of await listChapters(adaptationId)) {
    if (chapter.number < from || chapter.status !== 'drawn' || !chapter.script) continue
    await updateChapter(adaptationId, chapter.number, { redraw: chapter.script.map((_, pageIndex) => ({ page: pageIndex + 1, note: '' })) })
  }
  nudgeAdaptationRunner()
}

/** The adaptation goes before its journal runs, so a crash leaves runs whose adaptation is gone, never an adaptation missing history. */
export async function removeAdaptation(adaptationId: string): Promise<void> {
  interruptIf(adaptationId)
  // An interrupted capture still saves its run as it stops; deleting first would let that write bring the run back.
  await workerTasks.get(adaptationId)?.catch(() => undefined)
  clearLive(adaptationId)
  await deleteAdaptation(adaptationId)
  await deleteJournalAdaptation(adaptationId)
  const row = await getMangaByUrl(ADAPTED_SOURCE_ID, adaptedSeriesUrl(adaptationId))
  if (row?.favorite) await setFavorite(row.id, false)
  void queryClient?.invalidateQueries({ queryKey: ['db'] })
  nudgeAdaptationRunner()
}

export async function withGenerationReplacement(adaptationId: string, apply: () => Promise<readonly number[]>): Promise<void> {
  if (replacementLocks.has(adaptationId)) throw new Error('A replacement is already running for this adaptation.')
  replacementLocks.add(adaptationId)
  interruptIf(adaptationId)
  try {
    await workerTasks.get(adaptationId)
    const replace = async () => {
      const affected = await apply()
      await invalidatePublishedAdaptation(adaptationId, affected)
      clearLive(adaptationId)
      queryClient?.removeQueries({ queryKey: ['adapt'] })
      queryClient?.removeQueries({ queryKey: ['reader', 'pages', ADAPTED_SOURCE_ID, adaptationId] })
      await publishInOrder(adaptationId)
    }
    if (typeof navigator !== 'undefined' && navigator.locks) await navigator.locks.request(`kagi-adapt:${adaptationId}`, replace)
    else await replace()
  } finally {
    replacementLocks.delete(adaptationId)
    nudgeAdaptationRunner()
  }
}
