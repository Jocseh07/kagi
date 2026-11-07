import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { fetchSourceImage } from './transport'
import { tileLayout, validateTileGrid } from '../../../src/lib/images/tiles'
import type { Page } from '../../../src/lib/sources/types'
import type { DescrambleSpec } from '../../../src/lib/images/tiles'
import { localFilePath } from './storage'
import { awaitLocalImage } from './local-files-urls'

export interface CachedImage {
  path: string
  width: number
  height: number
}

interface CacheJob {
  promise: Promise<CachedImage>
  controller: AbortController
  users: number
  settled: boolean
}

const MAX_CACHE_BYTES = 512 * 1024 * 1024
const MAX_CACHE_FILES = 2048
const MAX_PENDING = 256
const MAX_ACTIVE = 4
const MAX_METADATA = 512
const MAX_IMAGE_PIXELS = 100_000_000
const IMAGE_SIZE_ERROR = 'The image exceeds the native image-cache limit.'
const jobs = new Map<string, CacheJob>()
const metadata = new Map<string, CachedImage>()
const diskFiles = new Map<string, { path: string; bytes: number; accessed: number }>()
const blobIdentities = new WeakMap<Blob, number>()
const blobWrites = new Map<string, Promise<CachedImage>>()
let nextBlobIdentity = 0
const waiters: { resolve(): void; reject(error: unknown): void; signal: AbortSignal; abort(): void }[] = []
let active = 0
let root: string | undefined
let clearing: Promise<void> | undefined
let maintenance = Promise.resolve()
let directoryReady: Promise<void> | undefined

export function configureContent(directory: string): void {
  if (jobs.size || active || clearing) throw new Error('Cannot change image storage while image work is active.')
  if (!directory.trim()) throw new Error('Choose a content storage directory.')
  root = join(resolve(directory), 'image-cache')
  metadata.clear()
  diskFiles.clear()
  directoryReady = undefined
}

export function imageCacheRoot(): string {
  if (!root) throw new Error('Configure content storage before loading images.')
  return root
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function ensureCacheDirectory(): Promise<void> {
  directoryReady ??= (async () => {
    const directory = imageCacheRoot()
    await mkdir(directory, { recursive: true })
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isFile() && /^\.[0-9a-f]{64}\.[0-9a-f-]{36}\.tmp$/.test(entry.name)) {
        await rm(join(directory, entry.name), { force: true })
      }
    }
    diskFiles.clear()
    for (const file of await cacheFiles()) diskFiles.set(file.path, file)
    await trimCache('')
  })().catch((error: unknown) => {
    directoryReady = undefined
    throw error
  })
  await directoryReady
}

async function acquire(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (active < MAX_ACTIVE) {
    active++
    return
  }
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const waiter = {
    resolve, reject, signal,
    abort() {
      const index = waiters.indexOf(waiter)
      if (index !== -1) waiters.splice(index, 1)
      reject(signal.reason)
    },
  }
  waiters.push(waiter)
  signal.addEventListener('abort', waiter.abort, { once: true })
  if (signal.aborted) waiter.abort()
  await promise
}

function release(): void {
  const next = waiters.shift()
  if (!next) {
    active--
    return
  }
  next.signal.removeEventListener('abort', next.abort)
  next.resolve()
}

async function withSlot<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  await acquire(signal)
  try {
    signal.throwIfAborted()
    return await work()
  } finally {
    release()
  }
}

async function subscribe(job: CacheJob, signal?: AbortSignal): Promise<CachedImage> {
  signal?.throwIfAborted()
  job.users++
  let abort: (() => void) | undefined
  try {
    if (!signal) return await job.promise
    const { promise, resolve, reject } = Promise.withResolvers<CachedImage>()
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    job.promise.then(resolve, reject)
    if (signal.aborted) abort()
    return await promise
  } finally {
    if (abort) signal?.removeEventListener('abort', abort)
    job.users--
    if (!job.users && !job.settled) job.controller.abort(new DOMException('Image request cancelled.', 'AbortError'))
  }
}

async function cached(key: string, work: (signal: AbortSignal) => Promise<CachedImage>, signal?: AbortSignal): Promise<CachedImage> {
  if (clearing) await clearing
  signal?.throwIfAborted()
  imageCacheRoot()
  let job = jobs.get(key)
  if (job?.controller.signal.aborted) {
    await job.promise.catch(() => undefined)
    job = jobs.get(key)
  }
  if (!job) {
    if (jobs.size >= MAX_PENDING) throw new Error('The image queue is full. Retry after current images finish.')
    const controller = new AbortController()
    const created: CacheJob = { controller, users: 0, settled: false, promise: Promise.resolve().then(() => withSlot(controller.signal, () => work(controller.signal))) }
    jobs.set(key, created)
    created.promise = created.promise.finally(() => {
      created.settled = true
      if (jobs.get(key) === created) jobs.delete(key)
    })
    job = created
  }
  return subscribe(job, signal)
}

function remember(value: CachedImage): CachedImage {
  metadata.delete(value.path)
  metadata.set(value.path, value)
  if (metadata.size > MAX_METADATA) metadata.delete(metadata.keys().next().value!)
  return value
}

function dimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS) {
    throw new Error(`Image dimensions are not supported: ${width} x ${height}.`)
  }
}

export async function imageInfo(path: string): Promise<{ width: number; height: number }> {
  const image = await loadImage(await readFile(path))
  dimensions(image.width, image.height)
  return { width: image.width, height: image.height }
}

async function existing(path: string): Promise<CachedImage | undefined> {
  try {
    await ensureCacheDirectory()
    const file = await stat(path)
    if (!file.isFile()) throw new Error('Cached image is not a regular file.')
    const known = metadata.get(path)
    const info = known ?? { path, ...await imageInfo(path) }
    const now = new Date()
    await utimes(path, now, now)
    diskFiles.set(path, { path, bytes: file.size, accessed: now.valueOf() })
    return remember(info)
  } catch (error) {
    if (isMissing(error)) {
      metadata.delete(path)
      diskFiles.delete(path)
      return undefined
    }
    throw error
  }
}

async function cacheFiles(): Promise<{ path: string; bytes: number; accessed: number }[]> {
  const directory = imageCacheRoot()
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  const result: { path: string; bytes: number; accessed: number }[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !/^[0-9a-f]{64}\.(png|jpg|webp|gif|avif|bmp|tiff|ico)$/.test(entry.name)) continue
    const path = join(directory, entry.name)
    try {
      const file = await stat(path)
      result.push({ path, bytes: file.size, accessed: file.mtimeMs })
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  return result
}

async function trimCache(protectedPath: string): Promise<void> {
  const files = [...diskFiles.values()]
  let bytes = files.reduce((sum, file) => sum + file.bytes, 0)
  let count = files.length
  if (bytes <= MAX_CACHE_BYTES && count <= MAX_CACHE_FILES) return
  for (const file of files.sort((a, b) => a.accessed - b.accessed)) {
    if (bytes <= MAX_CACHE_BYTES && count <= MAX_CACHE_FILES) break
    if (file.path === protectedPath) continue
    await rm(file.path, { force: true })
    metadata.delete(file.path)
    diskFiles.delete(file.path)
    bytes -= file.bytes
    count--
  }
}

async function persist(key: string, bytes: Uint8Array, info: { width: number; height: number }, suffix: string, signal: AbortSignal): Promise<CachedImage> {
  signal.throwIfAborted()
  if (bytes.byteLength > MAX_CACHE_BYTES) throw new Error(IMAGE_SIZE_ERROR)
  const directory = imageCacheRoot()
  const path = join(directory, `${key}.${suffix}`)
  await ensureCacheDirectory()
  const temporary = join(directory, `.${key}.${randomUUID()}.tmp`)
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(bytes)
      await file.sync()
    } finally {
      await file.close()
    }
    signal.throwIfAborted()
    const commit = maintenance.catch(() => undefined).then(async () => {
      signal.throwIfAborted()
      await rename(temporary, path)
      const parent = await open(directory, 'r')
      try {
        await parent.sync()
      } finally {
        await parent.close()
      }
      diskFiles.set(path, { path, bytes: bytes.byteLength, accessed: Date.now() })
      await trimCache(path)
    })
    maintenance = commit
    await commit
    signal.throwIfAborted()
    return remember({ path, width: info.width, height: info.height })
  } finally {
    await rm(temporary, { force: true })
  }
}

async function prepare(bytes: Uint8Array, spec?: DescrambleSpec): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const image = await loadImage(bytes)
  dimensions(image.width, image.height)
  const layout = spec ? tileLayout(image.width, image.height, spec) : undefined
  const width = layout?.width ?? image.width
  const height = layout?.height ?? image.height
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  if (layout) {
    for (const tile of layout.tiles) {
      context.drawImage(image, tile.sx, tile.sy, tile.width, tile.height, tile.dx, tile.dy, tile.width, tile.height)
    }
  } else {
    context.drawImage(image, 0, 0)
  }
  return { bytes: await canvas.encode('png'), width, height }
}

function localImageKey(path: string, file: BigIntStats, spec?: DescrambleSpec): string {
  return digest(JSON.stringify(['local-v1', path, String(file.dev), String(file.ino), String(file.size), String(file.mtimeNs), String(file.ctimeNs), spec]))
}

async function cacheLocalImage(url: string, spec: DescrambleSpec | undefined, signal?: AbortSignal): Promise<CachedImage> {
  signal?.throwIfAborted()
  const path = await awaitLocalImage(url)
  const observed = await stat(path, { bigint: true })
  return cached(localImageKey(path, observed, spec), async (jobSignal) => {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await file.stat({ bigint: true })
      if (!before.isFile()) throw new Error('The local image is not a regular file.')
      if (before.size > BigInt(MAX_CACHE_BYTES)) throw new Error(IMAGE_SIZE_ERROR)
      const key = localImageKey(path, before, spec)
      const hit = await existing(join(imageCacheRoot(), `${key}.png`))
      if (hit) return hit
      jobSignal.throwIfAborted()
      const bytes = await file.readFile()
      const after = await file.stat({ bigint: true })
      if (localImageKey(path, after, spec) !== key) throw new Error('The local image changed while loading. Retry the image.')
      jobSignal.throwIfAborted()
      const image = await prepare(bytes, spec)
      return await persist(key, image.bytes, image, 'png', jobSignal)
    } finally { await file.close() }
  }, signal)
}

export async function cacheSourceImage(sourceId: string, page: Page | string, signal?: AbortSignal): Promise<CachedImage> {
  const url = typeof page === 'string' ? page : page.imageUrl
  const spec = typeof page === 'string' ? undefined : page.descramble
  if (spec) validateTileGrid(spec)
  if (localFilePath(url)) return cacheLocalImage(url, spec, signal)
  const key = digest(JSON.stringify(['source-v1', sourceId, url, spec]))
  return cached(key, async (jobSignal) => {
    const hit = await existing(join(imageCacheRoot(), `${key}.png`))
    if (hit) return hit
    const bytes = await fetchSourceImage(sourceId, url, jobSignal)
    jobSignal.throwIfAborted()
    const image = await prepare(bytes, spec)
    return persist(key, image.bytes, image, 'png', jobSignal)
  }, signal)
}

export async function cacheBlobImage(key: string, blob: Blob): Promise<CachedImage> {
  let objectId = blobIdentities.get(blob)
  if (objectId === undefined) {
    objectId = ++nextBlobIdentity
    blobIdentities.set(blob, objectId)
  }
  return cached(`blob:${digest(key)}:${objectId}`, async (signal) => {
    if (blob.size > MAX_CACHE_BYTES) throw new Error(IMAGE_SIZE_ERROR)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    signal.throwIfAborted()
    const identity = digest(`${key}:${digest(bytes)}`)
    const hit = await existing(join(imageCacheRoot(), `${identity}.png`))
    if (hit) return hit
    const pending = blobWrites.get(identity)
    if (pending) return pending
    const write = prepare(bytes).then((image) => persist(identity, image.bytes, image, 'png', signal))
    blobWrites.set(identity, write)
    try {
      return await write
    } finally {
      if (blobWrites.get(identity) === write) blobWrites.delete(identity)
    }
  })
}

export async function imagePathFromBytes(bytes: Uint8Array, suffix = 'png'): Promise<string> {
  if (!/^[a-z0-9]+$/i.test(suffix)) throw new Error('Invalid image suffix.')
  const image = await cacheBlobImage(`bytes:${suffix}`, new Blob([Uint8Array.from(bytes)]))
  return image.path
}

export async function imageCacheBytes(): Promise<number> {
  if (clearing) await clearing
  await ensureCacheDirectory()
  return (await cacheFiles()).reduce((sum, file) => sum + file.bytes, 0)
}

export async function clearImageCache(): Promise<void> {
  if (clearing) return clearing
  const directory = imageCacheRoot()
  const current = [...jobs.values()]
  for (const job of current) job.controller.abort(new DOMException('Image cache cleared.', 'AbortError'))
  const operation = Promise.resolve().then(async () => {
    await Promise.allSettled(current.map((job) => job.promise))
    await maintenance.catch(() => undefined)
    await directoryReady?.catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
    metadata.clear()
    diskFiles.clear()
    directoryReady = undefined
  })
  clearing = operation
  try {
    await operation
  } finally {
    if (clearing === operation) clearing = undefined
  }
}
