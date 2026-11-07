import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createCanvas, loadCanvasImage, drawCanvasImage, releaseCanvasImage } from '../engine/adapters/canvas'
import { rows, type ScenarioContext } from './verify-scenarios'
import { until } from './verify-runtime'
import type { Row } from '../engine/protocol'

async function queued(context: ScenarioContext): Promise<Row[]> { return rows(await context.engine.screen('downloads'), 'download-queue') }
async function verifyPixels(path: string): Promise<void> {
  const image = await loadCanvasImage(Bun.file(path))
  try {
    assert.equal(image.width, 320); assert.equal(image.height, 480)
    const canvas = createCanvas(320, 480)
    const painter = canvas.getContext('2d')
    drawCanvasImage(painter, image, 0, 0, 320, 480)
    const data = painter.getImageData(0, 0, 320, 480).data
    for (let y = 0; y < 480; y++) for (let x = 0; x < 320; x++) {
      const at = (y * 320 + x) * 4
      assert.equal(data[at], x % 256); assert.equal(data[at + 1], y % 256); assert.equal(data[at + 2], (x ^ y) % 256); assert.equal(data[at + 3], 255)
    }
  } finally { releaseCanvasImage(image) }
}
export interface DownloadTarget { mangaId: string; chapterId: string; chapterTitle: string; hashes: string[] }
export async function runDownloads(context: ScenarioContext): Promise<DownloadTarget> {
  await context.engine.action('settings.save', { tab: 'library' }, { 'updates.interval_hours': '0' })
  const source = await context.engine.screen('source', { sourceId: 'asurascans' })
  const result = rows(source, 'source-results').find((row) => row.title === 'Native download fixture')
  const open = result?.actions?.find((action) => action.method === 'navigate' && action.params?.route === 'series')
  assert(open?.params)
  const series = await context.engine.screen('series', open.params)
  const chapters = rows(series, 'chapters')
  assert.equal(chapters.length, 3)
  const first = chapters[0].actions?.find((action) => action.method === 'navigate' && action.params?.route === 'reader')
  assert(first?.params)
  const mangaId = String(first.params.mangaId), chapterId = chapters[0].id
  const savedHashes: string[] = []
  await context.evidence.case('download-dedup-pause-restart-offline', 'Real source parser and persistent queue deduplicate submissions, abort active download on pause, recover after SIGKILL, and read exact saved pixels with the source offline', async () => {
    await context.provider.control({ sourceFault: 'hold' })
    await context.engine.action('downloads.pause')
    await Promise.all([context.engine.action('chapter.save', { chapterId }), context.engine.action('chapter.save', { chapterId })])
    let queue = (await queued(context)).filter((row) => row.title.includes(chapters[0].title))
    assert.equal(queue.length, 1, 'Duplicate chapter submissions created duplicate queue entries')
    const queueId = queue[0].id
    await context.engine.action('downloads.resume')
    await until(() => context.provider.control({ stats: true }), (stats) => stats.sourceActive > 0)
    await context.engine.action('downloads.pause')
    await until(() => context.provider.control({ stats: true }), (stats) => stats.sourceActive === 0, 3000)
    queue = await queued(context)
    assert(queue.some((row) => row.id === queueId && row.actions?.some((action) => action.method === 'downloads.item.resume')), 'Paused queue row lost its resumable state')
    await context.engine.action('downloads.resume')
    await until(() => context.provider.control({ stats: true }), (stats) => stats.sourceActive > 0)
    await context.restart(true)
    await context.provider.control({ sourceFault: 'none' })
    assert((await queued(context)).some((row) => row.id === queueId), 'Restart discarded the persistent queue identity')
    await context.engine.action('downloads.resume')
    await until(async () => rows(await context.engine.screen('series', { mangaId }), 'chapters'), (entries) => entries.some((row) => row.id === chapterId && row.subtitle?.includes('Saved offline')), 60_000)
    const reader = await context.engine.reader({ mangaId, chapterId })
    assert.equal(reader.pages?.length, 3)
    const paths: string[] = []
    const hashes: string[] = []
    for (const page of reader.pages ?? []) {
      assert(page.path, 'Completed download did not produce a persisted page path')
      await verifyPixels(page.path)
      paths.push(page.path); hashes.push(createHash('sha256').update(new Uint8Array(await Bun.file(page.path).arrayBuffer())).digest('hex'))
    }
    await context.provider.control({ sourceFault: 'offline' })
    const before = (await context.provider.control({ stats: true })).sourceRequests
    await context.restart()
    const saved = await context.engine.reader({ mangaId, chapterId })
    assert.deepEqual(saved.pages?.map((page) => page.path), paths)
    for (const [index, page] of (saved.pages ?? []).entries()) {
      assert(page.path)
      assert.equal(createHash('sha256').update(new Uint8Array(await Bun.file(page.path).arrayBuffer())).digest('hex'), hashes[index])
    }
    assert.equal((await context.provider.control({ stats: true })).sourceRequests, before, 'Saved reader contacted the offline source')
    await context.provider.control({ sourceFault: 'none' })
    await context.engine.action('chapter.unsave', { chapterId })
    for (const path of paths) assert.equal(await Bun.file(path).exists(), false, 'Unsave left stored image bytes behind')
    assert(!rows(await context.engine.screen('series', { mangaId }), 'chapters').find((row) => row.id === chapterId)?.subtitle?.includes('Saved offline'))
    savedHashes.push(...hashes)
    return { queueId, pageCount: 3, pageSha256: hashes, sourceRequestsWhileOffline: 0, deletionRemovedFiles: true }
  })
  await context.provider.control({ sourceFault: 'none' })
  await context.evidence.case('download-corrupt-image-retry', 'Invalid PNG fails without marking the chapter saved; retry obtains real decoded pages', async () => {
    const chapterId = chapters[1].id
    await context.provider.control({ sourceFault: 'corrupt', sourceRemaining: 1 })
    await context.engine.action('chapter.save', { chapterId })
    const failed = await until(() => queued(context), (entries) => entries.some((row) => row.title.includes(chapters[1].title) && row.actions?.some((action) => action.method === 'downloads.retry')), 60_000)
    const item = failed.find((row) => row.title.includes(chapters[1].title) && row.actions?.some((action) => action.method === 'downloads.retry'))
    assert(item)
    assert(!rows(await context.engine.screen('series', { mangaId }), 'chapters').find((row) => row.id === chapterId)?.subtitle?.includes('Saved offline'))
    await context.provider.control({ sourceFault: 'none' })
    await context.engine.action('downloads.retry', { queueId: item.id })
    await until(async () => rows(await context.engine.screen('series', { mangaId }), 'chapters'), (entries) => entries.some((row) => row.id === chapterId && row.subtitle?.includes('Saved offline')), 60_000)
    const reader = await context.engine.reader({ mangaId, chapterId })
    assert.equal(reader.pages?.length, 3)
    for (const page of reader.pages ?? []) { assert(page.path); await verifyPixels(page.path) }
    return { chapterId, pages: 3, invalidPageCommitted: false }
  })
  await context.provider.control({ sourceFault: 'none' })
  await context.evidence.case('queued-download-cancel', 'Removing queued chapter prevents image requests and removes its persistent queue row', async () => {
    await context.engine.action('downloads.pause')
    const before = (await context.provider.control({ stats: true })).sourceImages
    const chapterId = chapters[2].id
    await context.engine.action('chapter.save', { chapterId })
    const item = (await queued(context)).find((row) => row.title.includes(chapters[2].title))
    assert(item)
    await context.engine.action('downloads.remove', { queueId: item.id })
    await context.engine.action('downloads.resume')
    assert(!(await queued(context)).some((row) => row.id === item.id))
    assert.equal((await context.provider.control({ stats: true })).sourceImages, before)
    return { canceledQueueId: item.id, newImageRequests: 0 }
  })
  assert.equal(savedHashes.length, 3, 'Repeat-save requires the pixel-verified download reference')
  return { mangaId, chapterId, chapterTitle: chapters[0].title, hashes: savedHashes }
}
