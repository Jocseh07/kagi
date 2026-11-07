import assert from 'node:assert/strict'
import { readdir, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { planMihonImport } from '../../src/lib/backup/mihon-plan'
import { FIXTURES } from './verify-fixtures'
import { fields, rows, type ScenarioContext, type ScenarioState } from './verify-scenarios'
import { RpcError } from './verify-runtime'

function varint(value: number): Uint8Array {
  const output: number[] = []
  do { output.push((value & 127) | (value > 127 ? 128 : 0)); value = Math.floor(value / 128) } while (value)
  return new Uint8Array(output)
}
function proto(field: number, value: string | number | Uint8Array): Uint8Array {
  if (typeof value === 'number') return new Uint8Array([...varint(field * 8), ...varint(value)])
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  return new Uint8Array([...varint(field * 8 + 2), ...varint(bytes.length), ...bytes])
}
function message(...fields: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(fields.reduce((sum, value) => sum + value.length, 0))
  let at = 0
  for (const field of fields) { result.set(field, at); at += field.length }
  return result
}
export async function runIntegrity(context: ScenarioContext, state: ScenarioState): Promise<void> {
  await context.evidence.case('disk-full-export-atomicity', 'Actual ENOSPC preserves the previous export and leaves no temporary files', async () => {
    const root = join(context.root, 'fault-volume')
    const destination = join(root, 'retained.cbz')
    await Bun.write(destination, 'retained export')
    const space = await statfs(root)
    assert(space.blocks * space.bsize <= 2 * 1024 * 1024, 'ENOSPC fixture is not on the bounded scratch tmpfs')
    const fill = Math.max(0, space.bavail * space.bsize - 4096)
    await Bun.write(join(root, 'fill'), new Uint8Array(fill))
    const before = (await readdir(root)).sort()
    await assert.rejects(context.engine.action('chapter.export', { chapterId: state.comic.chapterId }, {}, [destination]), (error: unknown) => error instanceof RpcError && error.code === 'ACTION_FAILED' && /ENOSPC|space/i.test(error.message))
    assert.equal(await Bun.file(destination).text(), 'retained export')
    assert.deepEqual((await readdir(root)).sort(), before)
    return { preservedBytes: 'retained export', injected: 'kernel ENOSPC on 1 MiB private tmpfs', temporaryFiles: 0 }
  })
  await context.evidence.case('mihon-review-merge-progress', 'Canonical protobuf mapping, explicit review, idempotent merge, bookmarks and category assignment persist without network', async () => {
    const chapter = message(proto(1, '/series/native-mihon-fixture/chapter/1'), proto(2, 'Chapter 1'), proto(4, 1), proto(5, 1), proto(6, 7))
    const manga = message(proto(1, 429), proto(2, '/series/native-mihon-fixture'), proto(3, 'Native Mihon fixture'), proto(16, chapter), proto(17, new Uint8Array([0])))
    const source = message(proto(1, 'Asura Scans'), proto(2, 429))
    const category = message(proto(1, 'Imported fixture'), proto(2, 0))
    const bytes = new Uint8Array(gzipSync(message(proto(1, manga), proto(2, category), proto(101, source))))
    const plan = await planMihonImport(bytes)
    assert.equal(plan.entries.length, 1); assert.equal(plan.entries[0].sourceId, 'asurascans')
    assert.deepEqual(plan.categories, ['Imported fixture']); assert.equal(plan.sources[0].readChapters, 1)
    const path = join(context.root, 'fixtures/mihon.tachibk')
    await Bun.write(path, bytes)
    let mangaId = ''
    for (let iteration = 0; iteration < 2; iteration++) {
      await context.engine.action('mihon.review', {}, {}, [path])
      const review = await context.engine.screen('settings', { tab: 'data' })
      assert.equal(rows(review).find((row) => row.id === 'mihon-total')?.title, '1 of 1 series matched')
      const commit = review.sections.flatMap((section) => section.actions ?? []).find((action) => action.method === 'mihon.commit')
      assert(commit?.params)
      await context.engine.action('mihon.commit', commit.params)
      const matches = rows(await context.engine.screen('library'), 'library').filter((row) => row.title === 'Native Mihon fixture')
      assert.equal(matches.length, 1, 'Repeated import duplicated the manga')
      mangaId = matches[0].id
      const open = matches[0].actions?.find((action) => action.method === 'navigate' && action.params?.route === 'series')
      assert(open?.params)
      const series = await context.engine.screen('series', open.params)
      const chapters = rows(series, 'chapters')
      assert.equal(chapters.length, 1); assert.match(chapters[0].subtitle ?? '', /Read/); assert(chapters[0].badges?.includes('Bookmarked'))
      const assignments = await context.engine.action('library.categories', { mangaId })
      assert(assignments.screen?.dialog?.fields?.some((field) => field.label === 'Imported fixture' && field.value === 'true'))
      await assert.rejects(context.engine.action('mihon.commit', commit.params), (error: unknown) => error instanceof RpcError && /review|open/i.test(error.message))
    }
    await context.engine.action('series.favorite', { mangaId, favorite: false })
    return { source: 'asurascans', series: 1, chapters: 1, imports: 2, bookmarked: true, read: true }
  })
  await context.evidence.case('apply-and-duplicate-rejection', 'A successful script replay applies once, retains journal originals, then rejects duplicate application', async () => {
    const result = await context.engine.action('generation.retry', { generationId: state.scriptGeneration }, {}, [], 120_000)
    const replayId = result.screen?.sections.find((section) => section.id === 'generation-output')?.rows?.[0]?.id
    assert(replayId)
    await context.engine.action('generation.review', { generationId: replayId })
    await context.engine.action('generation.apply', { generationId: replayId })
    const screen = await context.engine.screen('generation', { generationId: replayId })
    const applied = rows(screen, 'generation-attempts').filter((row) => row.title === 'applied')
    assert.equal(applied.length, 1, 'Apply did not produce exactly one durable receipt')
    await assert.rejects(context.engine.action('generation.apply', { generationId: replayId }), (error: unknown) => error instanceof RpcError && /already been applied/i.test(error.message))
    const after = await context.engine.screen('generation', { generationId: replayId })
    assert.equal(rows(after, 'generation-attempts').filter((row) => row.title === 'applied').length, 1)
    const journal = rows(await context.engine.screen('journal', { adaptationId: state.adaptationId }), 'journal-runs')
    assert(journal.some((row) => row.id === state.scriptGeneration), 'Applying replacement removed original generation evidence')
    const input = fields(await context.engine.screen('adaptation', { adaptationId: state.adaptationId, tab: 'cast', who: 'mira' }))
    assert.equal(input.appearance, FIXTURES[0].input.characters[0].appearance)
    return { replayId, appliedReceipts: 1, originalsRetained: true }
  })
}
