import assert from 'node:assert/strict'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { BlobReader, BlobWriter, ZipWriter } from '@zip.js/zip.js'
import type { Params } from '../engine/protocol'
import { FIXED_TIME, png } from './verify-fixtures'
import { rows, type ScenarioContext } from './verify-scenarios'

export async function cachePressure(context: ScenarioContext): Promise<void> {
  await context.evidence.case('image-cache-count-eviction', '2100 distinct decoded local pages evict oldest cache entries at the canonical 2048-file bound; evicted content reloads identically', async () => {
    const path = join(context.fixtures.root, 'Cache Pressure.cbz')
    const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'), { useWebWorkers: false })
    for (let index = 0; index < 2100; index++) await writer.add(`${String(index + 1).padStart(4, '0')}.png`, new BlobReader(new Blob([new Uint8Array(png(16, 24, index))])), { level: 0, lastModDate: FIXED_TIME })
    await Bun.write(path, await writer.close())
    await context.engine.action('local.import', {}, {}, [path])
    const source = await context.engine.screen('source', { sourceId: 'local' })
    const series = rows(source, 'source-results').find((row) => /Cache Pressure/.test(row.title))
    const open = series?.actions?.find((action) => action.method === 'navigate' && action.params?.route === 'series')
    assert(open?.params)
    const screen = await context.engine.screen('series', open.params)
    const chapter = rows(screen, 'chapters')[0]
    const read = chapter?.actions?.find((action) => action.method === 'navigate' && action.params?.route === 'reader')
    assert(read?.params)
    const reader = await context.engine.reader(read.params)
    assert.equal(reader.pages?.length, 2100)
    let firstPath = '', firstHash = ''
    for (const [index, page] of (reader.pages ?? []).entries()) {
      assert(page.imageRef)
      const result = await context.engine.call('image.resolve', { image: page.imageRef as unknown as Params })
      const image = result.image
      assert(image && typeof image === 'object' && 'path' in image && typeof image.path === 'string' && 'width' in image && image.width === 16 && 'height' in image && image.height === 24)
      if (index === 0) { firstPath = image.path; firstHash = createHash('sha256').update(new Uint8Array(await Bun.file(firstPath).arrayBuffer())).digest('hex') }
      if (index % 100 === 99) await context.timed('cache-pressure', async () => { assert.equal(reader.pages?.length, 2100) })
    }
    assert.equal(await Bun.file(firstPath).exists(), false, 'Oldest unprotected cache file was not evicted')
    const cache = join(context.root, 'data/image-cache')
    const files = (await readdir(cache)).filter((name) => /^[a-f0-9]{64}\.(?:png|jpg|webp|gif|avif|bmp|tiff|ico)$/.test(name))
    assert(files.length <= 2048)
    let bytes = 0
    for (const file of files) bytes += (await stat(join(cache, file))).size
    assert(bytes <= 512 * 1024 * 1024)
    const first = reader.pages?.[0]?.imageRef
    assert(first)
    const regenerated = (await context.engine.call('image.resolve', { image: first as unknown as Params })).image
    assert(regenerated && typeof regenerated === 'object' && 'path' in regenerated && typeof regenerated.path === 'string')
    assert.equal(createHash('sha256').update(new Uint8Array(await Bun.file(regenerated.path).arrayBuffer())).digest('hex'), firstHash)
    return { decodedPages: 2100, retainedCacheFiles: files.length, retainedCacheBytes: bytes, oldestEvicted: true, reloadedSha256: firstHash }
  })
}
