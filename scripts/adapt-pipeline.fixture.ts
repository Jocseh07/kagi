import * as adaptKeys from '../src/lib/adapt/keys'
import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import type * as Pipeline from '../src/lib/adapt/pipeline'
import { createSlots } from '../src/lib/adapt/image-slots'
import { flaggedPanels } from '../src/lib/adapt/flow'
import type { Adaptation, Character, MangaChapter, PanelCheck, ScriptPage } from '../src/lib/adapt/store'
import * as realStore from '../src/lib/adapt/store'
import * as realClient from '../src/lib/adapt/client'
import * as realLive from '../src/lib/adapt/live'
import type * as Replacement from '../src/lib/adapt/journal/replacement'
import type { GenerationRecord } from '../src/lib/adapt/journal/types'
import { journalStore } from '../src/lib/adapt/journal/store'
import { mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createFileJournal } from '../desktop/src/journal-store'
import { getBundle } from '../src/lib/adapt/journal/store'
import { hashBlob, validateBundle } from '../src/lib/adapt/journal/helpers'
import type { GenerationApplication, GenerationState } from '../src/lib/adapt/store'

async function until(predicate: () => boolean) {
  for (let turn = 0; turn < 200; turn++) {
    if (predicate()) return
    await nextTurn()
  }
  throw new Error('Pipeline did not reach the expected state')
}

test('one image ceiling serves sheets and panels, prioritizes sheets, and cancels queued work', async () => {
  const slots = createSlots()
  const active = new AbortController()
  const cancelled = new AbortController()
  const gate = Promise.withResolvers<void>()
  const order: string[] = []
  let running = 0
  let peak = 0
  const run = async (name: string, wait = false) => {
    running++
    peak = Math.max(peak, running)
    order.push(name)
    if (wait) await gate.promise
    running--
  }
  const first = slots(2, 1, active.signal, () => run('panel-one', true))
  const second = slots(2, 2, active.signal, () => run('panel-two', true))
  const later = slots(2, 3, active.signal, () => run('later-panel'))
  const sheet = slots(2, 0, active.signal, () => run('sheet'))
  const skipped = slots(2, 0, cancelled.signal, () => run('cancelled'))
  const rejected = skipped.catch((error: unknown) => error)
  cancelled.abort(new Error('paused'))
  expect(await rejected).toEqual(new Error('paused'))
  expect(order).toEqual(['panel-one', 'panel-two'])
  gate.resolve()
  await Promise.all([first, second, later, sheet])
  expect(peak).toBe(2)
  expect(order).toEqual(['panel-one', 'panel-two', 'sheet', 'later-panel'])
})

test('an abort after a slot grant prevents the image request and releases capacity', async () => {
  const slots = createSlots()
  const controller = new AbortController()
  let called = false
  const task = slots(1, 0, controller.signal, async () => { called = true })
  controller.abort(new Error('paused'))
  await expect(task).rejects.toThrow('paused')
  expect(called).toBe(false)
  expect(await slots(1, 0, new AbortController().signal, async () => 'next')).toBe('next')
})

const adaptations = new Map<string, Adaptation>()
const chapters = new Map<string, MangaChapter>()
const characters = new Map<string, Character>()
const blobs = new Map<string, Blob>()
const pageEvents: string[] = []
const texts = new Map<string, string>()
const imageCalls: string[] = []
const checks: string[] = []
let imageRequest = async (prompt: string, _signal: AbortSignal) => new Blob([prompt])
let checkRequest = async (_shot: string, _signal: AbortSignal) => ({ ok: true, issue: '' })
const markPageComposed = realLive.markPageComposed
let published = 0
let reconciliationFails = false
let endpoint = 'http://fixture.invalid/v1'
const storeExports = { ...realStore }
const clientExports = { ...realClient }
const liveExports = { ...realLive }

mock.module('@/lib/db/repositories', () => ({
  getMangaByUrl: async () => undefined,
  setFavorite: async () => undefined,
  upsertChapters: async () => { published++ },
  upsertManga: async () => ({ id: 1, favorite: false }),
}))
mock.module('@/lib/sources/adapted', () => ({
  ADAPTED_SOURCE_ID: 'adapted',
  adaptedChapters: async () => [],
  adaptedSeries: async () => ({}),
  adaptedSeriesUrl: (id: string) => id,
}))
mock.module('@/lib/sources/registry', () => ({ getSource: () => { throw new Error('Unexpected source request') } }))
mock.module('@/lib/sources/types', () => ({ isTextSource: () => false }))
mock.module('@/lib/ui/describe-error', () => ({ describeError: (error: unknown) => error instanceof Error ? error.message : String(error) }))
mock.module('../src/lib/adapt/journal/published', () => ({
  invalidatePublishedAdaptation: async () => { if (reconciliationFails) throw new Error('Fixture publication failed') },
}))
mock.module('../src/lib/adapt/settings', () => ({
  readAdaptSettings: async () => ({
    endpoint, apiKey: '', planningModel: 'text', scriptModel: 'text', imageModel: 'image',
    concurrency: 3, chaptersAtOnce: 2, scriptsAhead: 1, readAhead: 1,
  }),
}))
mock.module('../src/lib/adapt/compose', () => ({
  downscale: async (blob: Blob) => blob,
  contactSheet: async (images: Blob[]) => new Blob(images),
  composePage: async (_layout: string, panels: { image: Blob }[]) => new Blob(panels.map((panel) => panel.image)),
  composeStrip: async (_tone: string, panels: { image: Blob }[]) => new Blob(panels.map((panel) => panel.image)),
}))
mock.module('../src/lib/adapt/client', () => ({
  ...clientExports,
  generateImage: async (_settings: unknown, _model: string, prompt: string, _size: string, signal: AbortSignal) => {
    imageCalls.push(prompt)
    return imageRequest(prompt, signal)
  },
  editImage: async (_settings: unknown, _model: string, prompt: string, _refs: Blob[], _size: string, signal: AbortSignal) => {
    imageCalls.push(prompt)
    return imageRequest(prompt, signal)
  },
}))
mock.module('../src/lib/adapt/check', () => ({
  MAX_CHECK_REDRAWS: 1,
  checkPanel: async (_settings: unknown, panel: { shot: string }, _cast: string[], _image: Blob, _refs: unknown[], signal: AbortSignal) => {
    checks.push(panel.shot)
    return checkRequest(panel.shot, signal)
  },
}))
mock.module('../src/lib/adapt/live', () => ({
  ...liveExports,
  markPageComposed: (adaptation: string, chapter: number, page: number) => {
    pageEvents.push(`${adaptation}:${chapter}:${page}`)
    markPageComposed(adaptation, chapter, page)
  },
}))

function patchChecks(adaptation: string, number: number, updates: ReadonlyMap<string, PanelCheck | undefined>) {
  const chapter = chapters.get(adaptKeys.chapterId(adaptation, number))!
  chapter.script = chapter.script!.map((page, pageIndex) => ({
    ...page,
    panels: page.panels.map((panel, panelIndex) => {
      const id = `${pageIndex + 1}-${panelIndex + 1}`
      return updates.has(id) ? { ...panel, check: updates.get(id) } : panel
    }),
  }))
}
mock.module('../src/lib/adapt/store', () => ({
  ...storeExports,
  getText: async (key: string) => texts.get(key),
  putText: async (key: string, value: string) => { texts.set(key, value) },
  hasPendingGenerationApplication: async (id: string) => [...texts].some(([key, value]) => key.startsWith(`${id}/journal/applied/`) && JSON.parse(value).phase === 'committed'),
  readGenerationState: async (id: string) => ({
    adaptation: structuredClone(adaptations.get(id)),
    chapters: structuredClone([...chapters.values()].filter((chapter) => chapter.adaptationId === id)),
    characters: structuredClone([...characters.values()].filter((character) => character.adaptationId === id)),
    blobs: new Map([...blobs].filter(([key]) => key.startsWith(`${id}/`))),
    texts: new Map([...texts].filter(([key]) => key.startsWith(`${id}/`))),
  }),
  commitGenerationState: async (_before: GenerationState, next: GenerationState, generationId: string, application: GenerationApplication) => {
    const id = next.adaptation.id
    adaptations.set(id, structuredClone(next.adaptation))
    for (const [key, chapter] of chapters) if (chapter.adaptationId === id) chapters.delete(key)
    for (const chapter of next.chapters) chapters.set(chapter.id, structuredClone(chapter))
    for (const [key, character] of characters) if (character.adaptationId === id) characters.delete(key)
    for (const character of next.characters) characters.set(character.id, structuredClone(character))
    for (const key of blobs.keys()) if (key.startsWith(`${id}/`)) blobs.delete(key)
    for (const [key, blob] of next.blobs) blobs.set(key, blob)
    for (const key of texts.keys()) if (key.startsWith(`${id}/`)) texts.delete(key)
    for (const [key, value] of next.texts) texts.set(key, value)
    texts.set(`${id}/journal/applied/${generationId}`, JSON.stringify(application))
  },
  listAdaptations: async () => structuredClone([...adaptations.values()]),
  getAdaptation: async (id: string) => structuredClone(adaptations.get(id)),
  updateAdaptation: async (id: string, patch: Partial<Adaptation>) => {
    const next = { ...adaptations.get(id)!, ...structuredClone(patch) }
    adaptations.set(id, next)
    return structuredClone(next)
  },
  listChapters: async (id: string) => structuredClone([...chapters.values()].filter((chapter) => chapter.adaptationId === id)),
  getChapter: async (id: string, number: number) => structuredClone(chapters.get(adaptKeys.chapterId(id, number))),
  updateChapter: async (id: string, number: number, patch: Partial<MangaChapter>) => {
    const key = adaptKeys.chapterId(id, number)
    const next = { ...chapters.get(key)!, ...structuredClone(patch) }
    chapters.set(key, next)
    return structuredClone(next)
  },
  listCharacters: async (id: string) => structuredClone([...characters.values()].filter((character) => character.adaptationId === id)),
  setSheetKey: async (id: string, lookId: string, key: string) => {
    expect(blobs.has(key)).toBe(true)
    const character = characters.get(id)!
    character.looks.find((look) => look.id === lookId)!.sheetKey = key
  },
  getBlob: async (key: string) => blobs.get(key),
  putBlob: async (key: string, blob: Blob) => { blobs.set(key, blob) },
  deleteBlob: async (key: string) => { blobs.delete(key) },
  deleteTexts: async () => undefined,
  patchPanelChecks: async (id: string, number: number, updates: ReadonlyMap<string, PanelCheck | undefined>) => patchChecks(id, number, updates),
  putPanelImage: async (id: string, chapter: number, page: number, panel: number, image: Blob, check: PanelCheck) => {
    blobs.set(adaptKeys.panelKey(id, chapter, page, panel), image)
    patchChecks(id, chapter, new Map([[`${page}-${panel}`, check]]))
  },
  listPanelKeys: async (id: string, chapter: number) => {
    const prefix = `${id}/panel/${chapter}/`
    return [...blobs.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))
  },
  listPageKeys: async (id: string, chapter: number) => {
    const prefix = `${id}/page/${chapter}/`
    return [...blobs.keys()].filter((key) => key.startsWith(prefix)).map((key) => Number(key.slice(prefix.length)))
  },
}))


let pipeline: typeof Pipeline
let replacement: typeof Replacement
beforeAll(async () => {
  // Import after mock installation, outside the test module's evaluation cycle.
  pipeline = await import('../src/lib/adapt/pipeline')
  replacement = await import('../src/lib/adapt/journal/replacement')
})
const client = { invalidateQueries: async () => undefined, removeQueries: () => undefined }

function fixture(id: string, pages: ScriptPage[], checkPanels = false) {
  const adaptation: Adaptation = {
    id, sourceId: 'novel', novelUrl: id, title: id, style: 'manga', styleNotes: '',
    novelChapterCount: 1, readThrough: 1, skipped: [], status: 'active', error: null,
    checkedAt: 0, createdAt: 0, skipPrologue: false, checkPanels,
  }
  const chapter: MangaChapter = {
    id: `${id}:1`, adaptationId: id, number: 1, title: 'Opening', summary: '',
    novelChapters: [{ index: 1, url: 'chapter-one', name: 'One' }], plan: 1,
    status: 'queued', script: pages, pageCount: 0, panelsDone: 0,
    panelsTotal: pages.reduce((sum, page) => sum + page.panels.length, 0),
    redraw: [], drawnAt: null, error: null,
  }
  adaptations.set(id, adaptation)
  chapters.set(chapter.id, chapter)
  return chapter.id
}

function page(shot: string, looks: string[] = []): ScriptPage {
  return { layout: 'strip', panels: [{ shot, looks, prompt: 'A person walks through a doorway.', text: [] }] }
}

afterEach(async () => {
  pipeline.stopAdaptationRunner()
  await nextTurn()
  adaptations.clear()
  chapters.clear()
  characters.clear()
  blobs.clear()
  texts.clear()
  pageEvents.length = 0
  imageCalls.length = 0
  checks.length = 0
  published = 0
  reconciliationFails = false
  endpoint = 'http://fixture.invalid/v1'
  imageRequest = async (prompt) => new Blob([prompt])
  checkRequest = async () => ({ ok: true, issue: '' })
})

test('a missing endpoint blocks a new adaptation and stops a running one before any request', async () => {
  endpoint = ''
  await expect(pipeline.createAdaptation('novel', { url: 'novel', title: 'Novel' } as never, 1, {
    style: 'manga', styleNotes: '', skipPrologue: false, checkPanels: false,
  })).rejects.toThrow(realClient.MISSING_ENDPOINT)
  expect(adaptations.size).toBe(0)

  fixture('unset', [page('first')])
  pipeline.startAdaptationRunner(client as never)
  await until(() => adaptations.get('unset')?.status === 'stopped')
  expect(adaptations.get('unset')?.error).toBe(realClient.MISSING_ENDPOINT)
  expect(imageCalls).toHaveLength(0)
})

test('shared sheets are deduplicated and an early page composes before an unrelated sheet completes', async () => {
  const slow = Promise.withResolvers<Blob>()
  const id = fixture('ready', [page('early', ['ada@main']), page('variant', ['ada@coat']), page('late', ['bea@main'])])
  characters.set('ada', {
    id: 'ada', adaptationId: 'ready', name: 'Ada', role: 'lead', appearance: 'Short hair', firstNovelChapter: 1,
    looks: [{ id: 'ada@main', name: 'main', change: '', sheetKey: null }, { id: 'ada@coat', name: 'coat', change: 'Wears a coat', sheetKey: null }],
  })
  characters.set('bea', {
    id: 'bea', adaptationId: 'ready', name: 'Bea', role: 'friend', appearance: 'Long hair', firstNovelChapter: 1,
    looks: [{ id: 'bea@main', name: 'main', change: '', sheetKey: null }],
  })
  imageRequest = async (prompt) => prompt.startsWith('Character reference sheet for Bea') ? slow.promise : new Blob([prompt])
  pipeline.startAdaptationRunner(client as never)
  try {
    await until(() => pageEvents.includes('ready:1:1') && pageEvents.includes('ready:1:2'))
    expect(blobs.has(adaptKeys.pageKey('ready', 1, 3))).toBe(false)
    expect(chapters.get(id)?.panelsDone).toBe(2)
    expect(imageCalls.filter((prompt) => prompt.startsWith('Character reference sheet for Ada (main)'))).toHaveLength(1)
    expect(imageCalls.filter((prompt) => prompt.startsWith('Character reference sheet for Ada (coat)'))).toHaveLength(1)
  } finally {
    slow.resolve(new Blob(['Bea sheet']))
  }
  await until(() => published === 1)
  expect(chapters.get(id)?.status).toBe('drawn')
})

test('pause during checking retains paid artwork and resume rechecks without drawing it again', async () => {
  const id = fixture('resume', [page('pending-check')], true)
  let checking = false
  checkRequest = async (_shot, signal) => {
    checking = true
    expect(blobs.has(adaptKeys.panelKey('resume', 1, 1, 1))).toBe(true)
    expect(chapters.get(id)?.script?.[0].panels[0].check?.status).toBe('pending')
    const pending = Promise.withResolvers<{ ok: boolean; issue: string }>()
    signal.addEventListener('abort', () => pending.reject(signal.reason), { once: true })
    return pending.promise
  }
  pipeline.startAdaptationRunner(client as never)
  await until(() => checking)
  await pipeline.pauseAdaptation('resume')
  await nextTurn()
  expect(chapters.get(id)?.script?.[0].panels[0].check?.status).toBe('pending')
  checkRequest = async () => ({ ok: true, issue: '' })
  await pipeline.resumeAdaptation('resume')
  await until(() => published === 1)
  expect(imageCalls).toHaveLength(1)
  expect(checks).toEqual(['pending-check', 'pending-check'])
  expect(chapters.get(id)?.script?.[0].panels[0].check?.status).toBe('passed')
  expect(pageEvents).toContain('resume:1:1')
})

test('a failed page drains siblings, preserves their composed pages, and retries only missing artwork', async () => {
  const slow = Promise.withResolvers<Blob>()
  const id = fixture('failure', [page('broken'), page('survivor')])
  imageRequest = async (prompt) => {
    if (prompt.includes('Scene: broken.')) throw new Error('upstream failure')
    return slow.promise
  }
  pipeline.startAdaptationRunner(client as never)
  try {
    await until(() => imageCalls.length === 2)
    expect(chapters.get(id)?.status).toBe('drawing')
  } finally {
    slow.resolve(new Blob(['paid survivor']))
  }
  await until(() => adaptations.get('failure')?.status === 'stopped')
  expect(pageEvents).toEqual(['failure:1:2'])
  expect(chapters.get(id)?.panelsDone).toBe(1)
  imageRequest = async (prompt) => new Blob([prompt])
  await pipeline.resumeAdaptation('failure')
  await until(() => published === 1)
  expect(imageCalls.filter((prompt) => prompt.includes('Scene: survivor.'))).toHaveLength(1)
  expect(imageCalls.filter((prompt) => prompt.includes('Scene: broken.'))).toHaveLength(2)
  expect(chapters.get(id)?.panelsDone).toBe(2)
})

test('an interrupted explicit redraw retains the replacement and does not buy it again', async () => {
  const id = fixture('redraw', [page('replacement')], true)
  const chapter = chapters.get(id)!
  chapter.status = 'drawn'
  chapter.drawnAt = 1
  chapter.pageCount = 1
  chapter.redraw = [{ id: 'request-one', page: 1, note: 'Move the camera left' }]
  chapter.script![0].panels[0].check = { status: 'passed', tries: 0 }
  const oldPage = new Blob(['old page'])
  blobs.set(adaptKeys.panelKey('redraw', 1, 1, 1), new Blob(['old panel']))
  blobs.set(adaptKeys.pageKey('redraw', 1, 1), oldPage)
  let checking = false
  checkRequest = async (_shot, signal) => {
    checking = true
    const pending = Promise.withResolvers<{ ok: boolean; issue: string }>()
    signal.addEventListener('abort', () => pending.reject(signal.reason), { once: true })
    return pending.promise
  }
  pipeline.startAdaptationRunner(client as never)
  await until(() => checking)
  await pipeline.pauseAdaptation('redraw')
  await nextTurn()
  const replacement = blobs.get(adaptKeys.panelKey('redraw', 1, 1, 1))
  expect(await replacement?.text()).toContain('Move the camera left')
  expect(blobs.get(adaptKeys.pageKey('redraw', 1, 1))).toBe(oldPage)
  checkRequest = async () => ({ ok: true, issue: '' })
  await pipeline.resumeAdaptation('redraw')
  await until(() => chapters.get(id)?.redraw.length === 0)
  expect(imageCalls).toHaveLength(1)
  expect(blobs.get(adaptKeys.panelKey('redraw', 1, 1, 1))).toBe(replacement)
  expect(chapters.get(id)?.script?.[0].panels[0].check?.status).toBe('passed')
})

test('disabled checks remain unflagged and enabling checks reuses saved artwork', async () => {
  const id = fixture('enable-checks', [page('saved-panel')], true)
  const chapter = chapters.get(id)!
  chapter.script![0].panels[0].check = { status: 'disabled', tries: 0 }
  const image = new Blob(['existing artwork'])
  blobs.set(adaptKeys.panelKey('enable-checks', 1, 1, 1), image)
  expect(flaggedPanels([chapter])).toEqual([])
  pipeline.startAdaptationRunner(client as never)
  await until(() => published === 1)
  expect(imageCalls).toEqual([])
  expect(checks).toEqual(['saved-panel'])
  expect(blobs.get(adaptKeys.panelKey('enable-checks', 1, 1, 1))).toBe(image)
  expect(chapters.get(id)?.script?.[0].panels[0].check?.status).toBe('passed')
})

test('replacement rejects changed inputs, changed validation, and newer generation ownership', async () => {
  fixture('replacement-guard', [page('Original shot')])
  const target = { adaptationId: 'replacement-guard', title: 'Fixture', chapter: 1, page: 1, panel: 1 }
  const captured = await replacement.captureGeneration('panel', target)
  const originalId = crypto.randomUUID()
  const now = Date.now()
  const replay: GenerationRecord = {
    ...captured.options.context!,
    schemaVersion: 1, id: crypto.randomUUID(), parentId: originalId, model: 'fixture',
    endpoint: 'http://localhost', status: 'succeeded', attempts: 1, ownerId: 'node:fixture',
    createdAt: now, updatedAt: now,
  }
  const getRun = journalStore.getRun
  journalStore.getRun = async (id) => id === originalId ? { ...replay, id: originalId, parentId: undefined } : undefined
  try {
    captured.options.onRecord?.(originalId)
    await captured.complete()
    expect((await replacement.getReplacementImpact(replay)).title).toBe('Fixture')
    await expect(replacement.getReplacementImpact({ ...replay, validation: { changed: true } })).rejects.toThrow('validation inputs')
    adaptations.get(target.adaptationId)!.styleNotes = 'New style'
    await expect(replacement.getReplacementImpact(replay)).rejects.toThrow('inputs changed')
    adaptations.get(target.adaptationId)!.styleNotes = ''
    const newer = await replacement.captureGeneration('panel', target)
    await newer.complete()
    await expect(replacement.getReplacementImpact(replay)).rejects.toThrow('newer generation')
  } finally {
    journalStore.getRun = getRun
  }
})

test('replacement preserves originals and retries reconciliation without replacing twice', async () => {
  fixture('replacement-apply', [page('Original shot'), page('Unchanged shot')])
  const id = 'replacement-apply'
  const key = adaptKeys.panelKey(id, 1, 1, 1)
  const otherKey = adaptKeys.panelKey(id, 1, 2, 1)
  const composedKey = adaptKeys.pageKey(id, 1, 1)
  blobs.set(key, new Blob(['old panel'], { type: 'image/png' }))
  blobs.set(otherKey, new Blob(['unchanged panel'], { type: 'image/png' }))
  blobs.set(composedKey, new Blob(['old page'], { type: 'image/png' }))
  const captured = await replacement.captureGeneration('panel', { adaptationId: id, title: 'Fixture', chapter: 1, page: 1, panel: 1 })
  const originalId = crypto.randomUUID()
  const now = Date.now()
  const replay: GenerationRecord = {
    ...captured.options.context!, schemaVersion: 1, id: crypto.randomUUID(), parentId: originalId,
    model: 'fixture', endpoint: 'http://localhost', status: 'succeeded', attempts: 1,
    ownerId: 'node:fixture', createdAt: now, updatedAt: now, outputArtifactId: crypto.randomUUID(),
  }
  const directory = await mkdtemp(resolve('.tmp/replacement-test-'))
  const store = await createFileJournal(directory)
  const getRun = journalStore.getRun
  journalStore.getRun = async (requested) => requested === originalId ? { ...replay, id: originalId, parentId: undefined } : undefined
  try {
    captured.options.onRecord?.(originalId)
    await captured.complete()
    await store.putRun(replay)
    const image = new Blob(['new panel'], { type: 'image/png' })
    await store.putArtifact({ id: replay.outputArtifactId!, generationId: replay.id, name: 'output.png', mime: image.type, size: image.size, sha256: await hashBlob(image), blob: image })
    reconciliationFails = true
    await expect(replacement.applyGeneration(replay, store)).rejects.toThrow('publication failed')
    expect(await blobs.get(key)?.text()).toBe('new panel')
    expect(await blobs.get(otherKey)?.text()).toBe('unchanged panel')
    expect(blobs.has(composedKey)).toBe(false)
    expect(adaptations.get(id)?.status).toBe('paused')
    await expect(pipeline.resumeAdaptation(id)).rejects.toThrow('pending generation replacement')
    const bundle = await getBundle(store, replay.id)
    await validateBundle(bundle)
    const backup = bundle.artifacts.find((artifact) => artifact.name === 'original-state.json')!
    const old = JSON.parse(await backup.blob.text()) as { blobs: Record<string, string> }
    expect(await (await store.getArtifact(old.blobs[key]))?.blob.text()).toBe('old panel')
    reconciliationFails = false
    await replacement.applyGeneration(replay, store)
    expect((await store.getRun(replay.id))?.appliedAt).toBeDefined()
    expect((await store.getArtifacts(replay.id)).map((artifact) => artifact.id).sort()).toEqual(bundle.artifacts.map((artifact) => artifact.id).sort())
    await expect(replacement.applyGeneration(replay, store)).rejects.toThrow('already been applied')
  } finally {
    journalStore.getRun = getRun
    await rm(directory, { recursive: true, force: true })
  }
})
