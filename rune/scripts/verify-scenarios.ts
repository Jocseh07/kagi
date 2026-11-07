import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { BlobReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js'
import type { Action, Params, Reader, Row, Screen } from '../engine/protocol'
import { FIXTURES, MODELS, UNICODE, validateSavedScript, type FixturePaths } from './verify-fixtures'
import { Engine, Evidence, Histogram, RpcError, delay, until } from './verify-runtime'
import type { ProviderHandle, Fault } from './verify-provider'

import type { DownloadTarget } from './verify-downloads'
export interface ScenarioContext {
  engine: Engine
  evidence: Evidence
  fixtures: FixturePaths
  provider: ProviderHandle
  root: string
  restart(crash?: boolean): Promise<void>
  timed(name: string, work: () => Promise<unknown>): Promise<void>
}
export interface ReadingTarget { mangaId: string; chapterId: string; pages: number; title: string; openSeries: Action; openReader: Action; resume: number }
export interface ScenarioState { novel: ReadingTarget; comic: ReadingTarget; adaptationId: string; generated: ReadingTarget; scriptGeneration: string }
export function rows(screen: Screen, id?: string): Row[] { return screen.sections.filter((section) => !id || section.id === id).flatMap((section) => section.rows ?? []) }
export function fields(screen: Screen): Record<string, string> { return Object.fromEntries(screen.sections.flatMap((section) => section.fields ?? []).map((field) => [field.id, field.value])) }
function actionOf(row: Row, method: string, route?: string): Action {
  const action = row.actions?.find((entry) => entry.method === method && (!route || entry.params?.route === route))
  assert(action, `Missing ${method}${route ? ` ${route}` : ''} on ${row.title}`)
  return action
}
async function rejects(work: Promise<unknown>, pattern: RegExp): Promise<string> {
  try { await work } catch (error) { assert(error instanceof RpcError); assert.equal(error.code, 'ACTION_FAILED'); assert.match(error.message, pattern); return error.message }
  throw new Error('Mutation unexpectedly succeeded')
}
async function openLocal(context: ScenarioContext, sourceId: string, title: RegExp): Promise<ReadingTarget> {
  const source = await context.engine.screen('source', { sourceId })
  const found = rows(source, 'source-results').find((row) => title.test(row.title))
  assert(found, `Imported title not found in ${sourceId}`)
  const open = actionOf(found, 'navigate', 'series')
  const series = await context.engine.screen('series', Object.fromEntries(Object.entries(open.params ?? {}).filter(([key]) => key !== 'route')) as Params)
  const chapters = rows(series, 'chapters')
  const read = chapters.flatMap((row) => row.actions ?? []).find((action) => action.method === 'navigate' && action.params?.route === 'reader')
  assert(read, 'Refreshed series did not expose a chapter reader action')
  const mangaId = String(read.params?.mangaId), chapterId = String(read.params?.chapterId)
  const reader = await context.engine.reader({ mangaId, chapterId })
  await context.engine.action('series.favorite', { mangaId, favorite: true })
  const library = await context.engine.screen('library')
  const libraryRow = rows(library, 'library').find((row) => row.id === mangaId)
  assert(libraryRow, 'Favorite did not persist into library query')
  return { mangaId, chapterId, pages: reader.pages?.length ?? 10000, title: series.title, openSeries: actionOf(libraryRow, 'navigate', 'series'), openReader: read, resume: 0 }
}
async function generationOutput(context: ScenarioContext, generationId: string): Promise<unknown> {
  const screen = await context.engine.screen('generation', { generationId, inspect: 'output' })
  const json = rows(screen).find((row) => row.id === 'output-json')?.detail
  assert(json, 'Journal saved output is not inspectable')
  const output = JSON.parse(json) as { journalValidated?: number; value?: unknown }
  assert.equal(output.journalValidated, 1, 'Text output was not canonically validated before persistence')
  return output.value
}
async function generatedReader(context: ScenarioContext, adaptationId: string): Promise<Reader> {
  await until(async () => {
    const screen = await context.engine.screen('adaptation', { adaptationId, tab: 'read' })
    return rows(screen, 'adapt-read').find((row) => row.actions?.some((action) => action.method === 'adapt.read' && action.params?.chapter === 1))
  }, Boolean, 180_000)
  const result = await context.engine.action('adapt.read', { adaptationId, chapter: 1 })
  assert(result.screen)
  const screen = result.screen
  await until(() => screen, (value) => Boolean(value.reader) && value.sections.every((section) => section.status !== 'loading'))
  assert(screen.reader, 'Generated reader content never arrived')
  assert.deepEqual(screen.sections.filter((section) => section.status === 'error'), [])
  return screen.reader
}
async function pageDigests(context: ScenarioContext, reader: Reader): Promise<string[]> {
  assert.equal(reader.kind, 'comic')
  const digests: string[] = []
  for (const page of reader.pages ?? []) {
    let path = page.path
    if (!path) {
      assert(page.imageRef, 'Page lacks both saved path and source reference')
      const result = await context.engine.call('image.resolve', { image: page.imageRef as unknown as Params })
      const image = result.image as { path: string; width: number; height: number }
      assert(image.width > 0 && image.height > 0, 'Native decoder rejected generated page')
      path = image.path
    }
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer())
    assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'Composed page must be a readable PNG')
    digests.push(createHash('sha256').update(bytes).digest('hex'))
  }
  return digests
}

export async function runFunctional(context: ScenarioContext): Promise<ScenarioState> {
  const { evidence, fixtures, provider } = context
  const initialized = await context.engine.call('database.status')
  const status = initialized.database as { ready: boolean; pending: unknown[] }
  if (!status.ready) {
    evidence.emit('database-initialize-approved', { pending: status.pending, dataDir: context.root })
    await context.engine.action('database.initialize')
  }
  const ready = (await context.engine.call('database.status')).database
  assert(ready && typeof ready === 'object' && 'ready' in ready && ready.ready === true)
  await evidence.case('empty-library', 'Fresh sandbox library has zero series', async () => {
    assert.deepEqual(rows(await context.engine.screen('library'), 'library'), [])
    return { series: 0 }
  })
  await evidence.case('fast-defaults', 'Exact current fast model IDs, Priority off, unchanged concurrency', async () => {
    const values = fields(await context.engine.screen('settings', { tab: 'adapt' }))
    for (const [key, value] of Object.entries(MODELS)) assert.equal(values[key], value)
    assert.equal(values.priority, 'false')
    evidence.emit('generation-limits', { values: Object.fromEntries(Object.entries(values).filter(([key]) => !['apiKey', 'endpoint'].includes(key))) })
    return { models: MODELS, priority: false }
  })
  await context.engine.action('settings.save', { tab: 'adapt' }, { endpoint: provider.endpoint, apiKey: '' })
  await evidence.case('imports', 'CBZ, folder, EPUB and Unicode text become selectable titles in their real source listings', async () => {
    await context.engine.action('local.import', {}, {}, [fixtures.novel, fixtures.unicode, fixtures.comic])
    await context.engine.action('local.folder', {}, {}, [fixtures.folder])
    const novels = rows(await context.engine.screen('source', { sourceId: 'local-novel' }), 'source-results').map((row) => row.title)
    const comics = rows(await context.engine.screen('source', { sourceId: 'local' }), 'source-results').map((row) => row.title)
    assert(novels.some((title) => /Brass Key/.test(title)) && novels.some((title) => /Unicode/.test(title)))
    assert(comics.some((title) => /Gradient/.test(title)) && comics.some((title) => /Folder Comic/.test(title)))
    return { files: ['Brass Key.epub', 'Unicode.txt', 'Gradient.cbz', 'Folder Comic'] }
  })
  const novel = await openLocal(context, 'local-novel', /Brass Key/)
  const comic = await openLocal(context, 'local', /Gradient/)
  await evidence.case('comic-decode-order', 'Two archive pages decode to exact fixture dimensions in natural order', async () => {
    const reader = await context.engine.reader({ mangaId: comic.mangaId, chapterId: comic.chapterId })
    assert.equal(reader.pages?.length, 2)
    const dimensions: number[][] = []
    for (const page of reader.pages ?? []) {
      assert(page.imageRef)
      const resolved = (await context.engine.call('image.resolve', { image: page.imageRef as unknown as Params })).image as { width: number; height: number }
      dimensions.push([resolved.width, resolved.height])
    }
    assert.deepEqual(dimensions, [[320, 480], [4096, 4096]])
    return { dimensions }
  })
  await evidence.case('unicode-text', 'CJK, RTL, emoji and combining characters survive the native text reader', async () => {
    const target = await openLocal(context, 'local-novel', /Unicode/)
    const reader = await context.engine.reader({ mangaId: target.mangaId, chapterId: target.chapterId })
    const text = reader.blocks?.map((block) => block.text ?? block.spans?.map((span) => span.text).join('') ?? '').join('\n') ?? ''
    assert(text.includes(UNICODE), 'Unicode text changed during import or prose parsing')
    let repetitions = 0
    for (const _match of text.matchAll(/Long paragraph/g)) repetitions++
    assert.equal(repetitions, 20_000, 'Huge paragraph was truncated during native import or parsing')
    return { unicode: UNICODE, largeParagraphRepetitions: repetitions }
  })
  await evidence.case('settings-error-retention', 'Invalid reader values fail without changing the saved values', async () => {
    const before = fields(await context.engine.screen('settings', { tab: 'reader' }))
    await rejects(context.engine.action('settings.save', { tab: 'reader' }, { fontSize: '-1' }), /font|size|between|valid|whole/i)
    assert.deepEqual(fields(await context.engine.screen('settings', { tab: 'reader' })), before)
    return { persisted: 'unchanged' }
  })
  await evidence.case('categories-roundtrip', 'Assign, rename and delete preserve the favorite without orphan membership', async () => {
    await context.engine.action('category.save', {}, { categoryName: 'Native fixture' })
    const row = rows(await context.engine.screen('categories'), 'categories').find((entry) => entry.title === 'Native fixture')
    assert(row)
    await context.engine.action('library.categories.save', { mangaIds: [novel.mangaId] }, { [`category:${row.id}`]: 'true' })
    assert.deepEqual(rows(await context.engine.screen('library', { categoryId: row.id }), 'library').map((entry) => entry.id), [novel.mangaId])
    await context.engine.action('category.save', { categoryId: row.id }, { categoryName: 'Renamed fixture' })
    assert(rows(await context.engine.screen('categories'), 'categories').some((entry) => entry.id === row.id && entry.title === 'Renamed fixture'))
    await context.engine.action('category.delete', { categoryId: row.id })
    assert(!rows(await context.engine.screen('categories'), 'categories').some((entry) => entry.id === row.id))
    assert(rows(await context.engine.screen('library'), 'library').some((entry) => entry.id === novel.mangaId))
    return { seriesRetained: novel.mangaId }
  })
  await evidence.case('bookmark-filter', 'Bookmarked tri-state filter includes then excludes the chapter', async () => {
    await context.engine.action('chapter.bookmark', { chapterId: comic.chapterId, bookmarked: true })
    assert(rows(await context.engine.screen('series', { mangaId: comic.mangaId, chapterFilter: 'bookmarked' }), 'chapters').some((entry) => entry.id === comic.chapterId))
    await context.engine.action('chapter.bookmark', { chapterId: comic.chapterId, bookmarked: false })
    assert(!rows(await context.engine.screen('series', { mangaId: comic.mangaId, chapterFilter: 'bookmarked' }), 'chapters').some((entry) => entry.id === comic.chapterId))
    return { bookmarkCleared: true }
  })
  await evidence.case('local-download-rejection', 'Already local chapters are rejected without creating queued work', async () => {
    const before = rows(await context.engine.screen('downloads')).map((entry) => entry.id)
    await rejects(context.engine.action('chapter.save', { chapterId: comic.chapterId }), /already live on this device/i)
    assert.deepEqual(rows(await context.engine.screen('downloads')).map((entry) => entry.id), before)
    return { queue: 'unchanged' }
  })
  const start = performance.now()
  const create = await context.engine.action('adapt.create', { mangaId: novel.mangaId }, { style: 'manga', skipPrologue: 'false', checkPanels: 'true', stopAt: '1' })
  const adaptationId = String(create.screen?.tabs?.[0]?.params?.adaptationId ?? '')
  assert(adaptationId, 'Create adaptation did not return its stable ID')
  const generated = await generatedReader(context, adaptationId)
  const firstReadableMs = performance.now() - start
  assert.equal(generated.pages?.length, 6, 'Generated storyboard page count changed')
  await context.engine.action('adapt.pause', { adaptationId })
  const journal = await context.engine.screen('journal', { adaptationId, stage: 'script', status: 'succeeded' })
  const scriptGeneration = rows(journal, 'journal-runs')[0]?.id
  assert(scriptGeneration, 'No successful script journal record')
  const script = await generationOutput(context, scriptGeneration)
  await validateSavedScript(script, FIXTURES[0].input)
  assert.deepEqual(script, FIXTURES[0].pages, 'Pipeline changed canonical storyboard or dialogue')
  const savedPages = await pageDigests(context, generated)
  assert.equal(savedPages.length, FIXTURES[0].pages.length)
  evidence.counts.pass++; evidence.emit('case', { name: 'novel-adaptation-generation-inspect-read', status: 'pass', expected: 'Canonical six-page script and dialogue persist; composed pages decode', observed: { adaptationId, firstReadableMs, scriptGeneration, pageSha256: savedPages } })
  await context.engine.action('series.favorite', { mangaId: generated.seriesId, favorite: true })
  const generatedLibrary = rows(await context.engine.screen('library'), 'library').find((row) => row.id === generated.seriesId)
  assert(generatedLibrary)
  const generatedSeries = await context.engine.screen('series', { mangaId: generated.seriesId })
  const generatedChapter = rows(generatedSeries, 'chapters').find((row) => row.id === generated.chapterId)
  assert(generatedChapter)
  const target: ReadingTarget = { mangaId: generated.seriesId, chapterId: generated.chapterId, pages: 6, title: generatedSeries.title, openSeries: actionOf(generatedLibrary, 'navigate', 'series'), openReader: actionOf(generatedChapter, 'navigate', 'reader'), resume: 2 }
  await evidence.case('restart-position-and-offline-reading', 'Chapter identity, page 2 plus offset 0.375 and all six composed hashes survive SIGKILL and provider outage', async () => {
    await context.engine.reader({ mangaId: target.mangaId, chapterId: target.chapterId })
    await context.engine.call('reader.progress', { chapterId: target.chapterId, position: 2, offset: 0.375, pageCount: 6 })
    await context.restart(true)
    await provider.control({ fault: 'offline', remaining: 50_000 })
    const requests = (await provider.control({ stats: true })).requests
    const resumed = await context.engine.reader({ mangaId: target.mangaId, chapterId: target.chapterId })
    assert.equal(resumed.chapterId, target.chapterId); assert.equal(resumed.position, 2.375)
    assert.deepEqual(await pageDigests(context, resumed), savedPages)
    assert.equal((await provider.control({ stats: true })).requests, requests, 'Saved reading unexpectedly contacted provider')
    await provider.control({ fault: 'none', remaining: 0 })
    return { position: resumed.position, pageSha256: savedPages, providerRequests: 0 }
  })
  await evidence.case('novel-position-resume', 'Novel progress 4321 persists after orderly engine restart', async () => {
    await context.engine.reader({ mangaId: novel.mangaId, chapterId: novel.chapterId })
    await context.engine.call('reader.progress', { chapterId: novel.chapterId, position: 4321, pageCount: 10000 })
    await context.restart()
    assert.equal((await context.engine.reader({ mangaId: novel.mangaId, chapterId: novel.chapterId })).position, 4321)
    return { position: 4321 }
  })
  await evidence.case('backup-restore', 'Backup restores exact library IDs and saved reader position after deliberate scratch mutation', async () => {
    const destination = join(context.root, 'library.sqlite')
    const before = rows(await context.engine.screen('library'), 'library').map((entry) => entry.id).sort()
    await context.engine.action('backup.export', {}, {}, [destination])
    assert.equal(new TextDecoder().decode(new Uint8Array(await Bun.file(destination).arrayBuffer()).slice(0, 16)), 'SQLite format 3\0')
    await context.engine.action('series.favorite', { mangaId: novel.mangaId, favorite: false })
    assert(!rows(await context.engine.screen('library'), 'library').some((entry) => entry.id === novel.mangaId))
    await context.engine.action('backup.restore', {}, {}, [destination])
    assert.deepEqual(rows(await context.engine.screen('library'), 'library').map((entry) => entry.id).sort(), before)
    assert.equal((await context.engine.reader({ mangaId: novel.mangaId, chapterId: novel.chapterId })).position, 4321)
    await context.engine.action('settings.save', { tab: 'adapt' }, { endpoint: provider.endpoint })
    return { libraryIds: before, novelPosition: 4321 }
  })
  await evidence.case('archive-export-content', 'CBZ export preserves the two decoded source pages and archive order', async () => {
    const destination = join(context.root, 'export.cbz')
    await context.engine.action('chapter.export', { chapterId: comic.chapterId }, {}, [destination])
    const reader = new ZipReader(new BlobReader(Bun.file(destination)), { useWebWorkers: false })
    try {
      const entries = (await reader.getEntries()).filter((entry) => !entry.directory)
      assert.deepEqual(entries.map((entry) => entry.filename), ['0001.png', '0002.png'])
      const dimensions: number[][] = []
      for (const entry of entries) {
        assert(entry.getData)
        const bytes = await entry.getData(new Uint8ArrayWriter())
        const buffer = Buffer.from(bytes)
        assert.equal(buffer.toString('ascii', 12, 16), 'IHDR')
        dimensions.push([buffer.readUInt32BE(16), buffer.readUInt32BE(20)])
      }
      assert.deepEqual(dimensions, [[320, 480], [4096, 4096]])
      return { archivePages: dimensions }
    } finally { await reader.close() }
  })
  await evidence.case('failed-export-atomicity', 'Export to a directory fails and leaves no temporary siblings or altered library IDs', async () => {
    const directory = join(context.root, 'cannot-replace-directory')
    await mkdir(directory)
    const before = (await readdir(context.root)).sort()
    await rejects(context.engine.action('chapter.export', { chapterId: comic.chapterId }, {}, [directory]), /directory|EISDIR|rename/i)
    assert.deepEqual((await readdir(context.root)).sort(), before)
    assert((await stat(directory)).isDirectory())
    return { temporaryFiles: 0 }
  })
  return { novel, comic, adaptationId, generated: target, scriptGeneration }
}

export async function runProviderEdges(context: ScenarioContext, state: ScenarioState): Promise<void> {
  const { evidence, provider } = context
  await context.engine.action('settings.save', { tab: 'adapt' }, { endpoint: provider.endpoint })
  for (const fault of ['malformed', '429', '5xx'] as Fault[]) {
    await evidence.case(`journal-replay-${fault}`, 'Replay hard cap sends one request, records failed evidence, and never applies invalid output', async () => {
      await provider.control({ fault, remaining: 1 })
      const before = await provider.control({ stats: true })
      const result = await context.engine.action('generation.retry', { generationId: state.scriptGeneration }, {}, [], 120_000)
      const id = result.screen?.sections.find((section) => section.id === 'generation-output')?.rows?.[0]?.id
      assert(id && id !== state.scriptGeneration)
      const replay = rows(await context.engine.screen('journal', { adaptationId: state.adaptationId, stage: 'script' }), 'journal-runs').find((row) => row.id === id)
      assert(replay?.badges?.includes('failed'), 'Faulty one-request replay must retain its failed journal result')
      const after = await provider.control({ stats: true })
      assert.equal(after.injected - before.injected, 1)
      assert.equal(after.requests - before.requests, 1, 'Replay exceeded its canonical maxRequests: 1 cap')
      assert.deepEqual(await generationOutput(context, state.scriptGeneration), FIXTURES[0].pages)
      return { injected: 1, requests: 1, failedReplay: id }
    })
  }
  await evidence.case('timeout-cancellation', 'Hanging model discovery cancels within 2 seconds and leaves provider active count zero', async () => {
    await provider.control({ fault: 'timeout', remaining: 1 })
    const request = context.engine.request('action', { action: { id: 'timeout-models', label: 'models', method: 'settings.adapt.models', params: {} }, values: { endpoint: provider.endpoint }, selectedPaths: [] }, 20_000)
    const outcome = request.result.then(() => ({ success: true, code: '' }), (error: unknown) => ({ success: false, code: error instanceof RpcError ? error.code : String(error) }))
    await until(() => provider.control({ stats: true }), (stats) => stats.active === 1)
    const start = performance.now()
    await context.engine.call('cancel', { requestId: request.id })
    const result = await outcome
    assert.equal(result.success, false)
    assert.equal(result.code, 'CANCELED')
    assert(performance.now() - start <= 2000, 'Cancellation left model discovery running')
    await until(() => provider.control({ stats: true }), (stats) => stats.active === 0, 2000)
    return { code: result.code, canceledWithinMs: performance.now() - start }
  })
  await provider.control({ fault: 'none', remaining: 0 })
  await evidence.case('duplicate-inflight-submission', 'Concurrent identical connection checks produce one provider request and equivalent model discoveries', async () => {
    const before = await provider.control({ stats: true })
    const params: Params = { action: { id: 'duplicate-models', label: 'models', method: 'settings.adapt.models', params: {} }, values: { endpoint: provider.endpoint }, selectedPaths: [] }
    const [a, b] = await Promise.all([context.engine.call('action', params), context.engine.call('action', params)])
    const modelIds = (screen: Screen | undefined) => screen?.sections.find((section) => section.id === 'adapt-models')?.rows?.map((row) => row.id).sort()
    assert.deepEqual(modelIds(a.screen), modelIds(b.screen))
    assert.deepEqual(modelIds(a.screen), [...new Set(Object.values(MODELS))].sort())
    assert.equal((await provider.control({ stats: true })).requests - before.requests, 1)
    return { requests: 1 }
  })
  await evidence.case('interrupted-replay-recovery', 'SIGKILL during a real provider request leaves an interrupted journal, preserves the original script and permits a new replay after restart', async () => {
    await provider.control({ fault: 'timeout', remaining: 1 })
    const request = context.engine.request('action', { action: { id: 'interrupted-replay', label: 'replay', method: 'generation.retry', params: { generationId: state.scriptGeneration } }, values: {}, selectedPaths: [] }, 30_000)
    const outcome = request.result.catch(() => undefined)
    await until(() => provider.control({ stats: true }), (value) => value.active === 1)
    await context.restart(true)
    await outcome
    await provider.control({ fault: 'none', remaining: 0 })
    await until(() => provider.control({ stats: true }), (value) => value.active === 0, 2000)
    const interrupted = rows(await context.engine.screen('journal', { adaptationId: state.adaptationId, stage: 'script', status: 'interrupted' }), 'journal-runs')
    assert(interrupted.some((row) => row.badges?.includes('interrupted')), 'Running generation was not recovered as interrupted')
    assert.deepEqual(await generationOutput(context, state.scriptGeneration), FIXTURES[0].pages)
    const replay = await context.engine.action('generation.retry', { generationId: state.scriptGeneration }, {}, [], 120_000)
    const id = replay.screen?.sections.find((section) => section.id === 'generation-output')?.rows?.[0]?.id
    assert(id)
    await validateSavedScript(await generationOutput(context, id), FIXTURES[0].input)
    return { interrupted: interrupted.map((row) => row.id), recoveredReplay: id }
  })
  await evidence.case('journal-export-import-integrity', 'Export/import preserves saved generation IDs and validated script exactly', async () => {
    const path = join(context.root, 'journal.zip')
    const original = await generationOutput(context, state.scriptGeneration)
    await context.engine.action('journal.export', { generationId: state.scriptGeneration }, {}, [path])
    await context.engine.action('generation.delete', { generationId: state.scriptGeneration })
    assert(!rows(await context.engine.screen('journal', { adaptationId: state.adaptationId }), 'journal-runs').some((row) => row.id === state.scriptGeneration), 'Deleted generation remains in journal listing')
    await context.engine.action('journal.import', {}, {}, [path])
    assert.deepEqual(await generationOutput(context, state.scriptGeneration), original)
    return { restored: state.scriptGeneration }
  })
  await evidence.case('stale-replacement-rejected', 'Changing cast appearance after replay rejects apply and preserves current appearance', async () => {
    const retried = await context.engine.action('generation.retry', { generationId: state.scriptGeneration }, {}, [], 120_000)
    const replayId = retried.screen?.sections.find((section) => section.id === 'generation-output')?.rows?.[0]?.id
    assert(replayId)
    await context.engine.action('adapt.character', { adaptationId: state.adaptationId, characterId: 'mira' }, { appearance: 'Mira wears a bright yellow coat.', redraw: 'false' })
    await rejects(context.engine.action('generation.apply', { generationId: replayId }), /inputs changed|dependencies have changed|newer generation/i)
    assert.equal(fields(await context.engine.screen('adaptation', { adaptationId: state.adaptationId, tab: 'cast', who: 'mira' })).appearance, 'Mira wears a bright yellow coat.')
    await context.engine.action('adapt.character', { adaptationId: state.adaptationId, characterId: 'mira' }, { appearance: FIXTURES[0].input.characters[0].appearance, redraw: 'false' })
    return { rejected: replayId, appearanceRetained: true }
  })
}

export async function runLargeFixtures(context: ScenarioContext): Promise<void> {
  await context.evidence.case('thousand-chapters', 'EPUB spine yields exactly 1000 ordered chapter rows; chapter 1000 retains Unicode', async () => {
    await context.engine.action('local.import', {}, {}, [context.fixtures.many])
    const source = await context.engine.screen('source', { sourceId: 'local-novel' })
    const entry = rows(source, 'source-results').find((row) => /Thousand Chapters/.test(row.title))
    assert(entry)
    const series = await context.engine.screen('series', actionOf(entry, 'navigate', 'series').params ?? {})
    const chapters = rows(series, 'chapters')
    assert.equal(chapters.length, 1000)
    assert.equal(new Set(chapters.map((chapter) => chapter.id)).size, 1000)
    const action = actionOf(chapters[999], 'navigate', 'reader')
    const reader = await context.engine.reader(action.params ?? {})
    assert(reader.blocks?.some((block) => (block.text ?? block.spans?.map((span) => span.text).join('') ?? '').includes(UNICODE)))
    return { chapters: 1000, lastChapter: reader.chapterId }
  })
  await context.evidence.case('malformed-epub', 'Malformed archive cannot become a readable chapter', async () => {
    await context.engine.action('local.import', {}, {}, [context.fixtures.malformed])
    const source = await context.engine.screen('source', { sourceId: 'local-novel' })
    const entry = rows(source, 'source-results').find((row) => /broken/i.test(row.title))
    if (!entry) return { rejectedBeforeListing: true }
    let failed = false
    try { await context.engine.screen('series', actionOf(entry, 'navigate', 'series').params ?? {}) } catch { failed = true }
    assert(failed, 'Malformed EPUB unexpectedly produced a usable series')
    return { rejectedOnOpen: true }
  })
}

export async function repeatActions(context: ScenarioContext, state: ScenarioState, repeat: number, download: DownloadTarget): Promise<void> {
  const actions: [string, () => Promise<unknown>][] = [
    ['open', async () => { const reader = await context.engine.reader({ mangaId: state.comic.mangaId, chapterId: state.comic.chapterId }); assert.equal(reader.pages?.length, 2) }],
    ['navigate', async () => { assert(rows(await context.engine.screen('library'), 'library').some((row) => row.id === state.novel.mangaId)) }],
    ['save', async () => {
      await context.engine.action('downloads.clearFinished')
      await context.engine.action('chapter.save', { chapterId: download.chapterId })
      await until(async () => rows(await context.engine.screen('downloads'), 'download-queue'), (entries) => entries.some((row) => row.title.includes(download.chapterTitle) && row.actions?.some((action) => action.method === 'navigate' && action.params?.route === 'reader')), 60_000)
      const reader = await context.engine.reader({ mangaId: download.mangaId, chapterId: download.chapterId })
      assert.equal(reader.pages?.length, 3)
      for (const [index, page] of (reader.pages ?? []).entries()) {
        assert(page.path)
        assert.equal(createHash('sha256').update(new Uint8Array(await Bun.file(page.path).arrayBuffer())).digest('hex'), download.hashes[index])
      }
      await context.engine.action('chapter.unsave', { chapterId: download.chapterId })
      for (const page of reader.pages ?? []) { assert(page.path); assert.equal(await Bun.file(page.path).exists(), false) }
    }],
    ['cancel', async () => { await cancelReplay(context, state) }],
    ['generate', async () => { const result = await context.engine.action('generation.retry', { generationId: state.scriptGeneration }, {}, [], 120_000); const id = result.screen?.sections.find((section) => section.id === 'generation-output')?.rows?.[0]?.id; assert(id); await validateSavedScript(await generationOutput(context, id), FIXTURES[0].input); await context.engine.action('generation.delete', { generationId: id }) }],
  ]
  for (const [name, action] of actions) {
    const histogram = new Histogram()
    for (let i = 0; i < repeat; i++) {
      const start = performance.now()
      const passed = await context.evidence.case(`repeat-${name}`, 'Consumer-visible state remains correct in one engine process', async () => { await context.timed(`repeat:${name}`, action); return { iteration: i + 1 } })
      histogram.add(performance.now() - start)
      if (!passed) break
    }
    context.evidence.emit('repeat-summary', { name, ...histogram.result(), requested: repeat })
  }
}

export async function mixedAction(context: ScenarioContext, state: ScenarioState, choose: number): Promise<void> {
  if (choose < 0.25) {
    const reader = await context.engine.reader({ mangaId: state.comic.mangaId, chapterId: state.comic.chapterId })
    assert.equal(reader.pages?.length, 2)
  } else if (choose < 0.5) {
    const reader = await context.engine.reader({ mangaId: state.novel.mangaId, chapterId: state.novel.chapterId })
    assert.equal(reader.kind, 'novel')
  } else if (choose < 0.75) {
    const screen = await context.engine.screen('library')
    assert(rows(screen, 'library').some((row) => row.id === state.novel.mangaId))
  } else {
    await context.engine.action('chapter.bookmark', { chapterId: state.comic.chapterId, bookmarked: true })
    await context.engine.action('chapter.bookmark', { chapterId: state.comic.chapterId, bookmarked: false })
  }
  await delay(50)
}

async function cancelReplay(context: ScenarioContext, state: ScenarioState): Promise<void> {
  await context.provider.control({ fault: 'timeout', remaining: 1 })
  const request = context.engine.request('action', { action: { id: 'cancel-replay', label: 'replay', method: 'generation.retry', params: { generationId: state.scriptGeneration } }, values: {}, selectedPaths: [] }, 20_000)
  const outcome = request.result.then((result) => ({ result }), (error: unknown) => ({ error }))
  await until(() => context.provider.control({ stats: true }), (value) => value.active === 1)
  const start = performance.now()
  await context.engine.call('cancel', { requestId: request.id })
  await outcome
  assert(performance.now() - start <= 2000, 'Replay cancellation exceeded 2 seconds')
  await until(() => context.provider.control({ stats: true }), (value) => value.active === 0, 2000)
  const cancelled = rows(await context.engine.screen('journal', { adaptationId: state.adaptationId, stage: 'script', status: 'cancelled' }), 'journal-runs')
  assert(cancelled.some((row) => row.badges?.includes('cancelled')), 'Canceled replay has no durable cancellation evidence')
  for (const row of cancelled) await context.engine.action('generation.delete', { generationId: row.id })
  await context.provider.control({ fault: 'none', remaining: 0 })
}
