import { existsSync } from 'node:fs'
import { lstat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite, localFilePath, storageKey, storageRoot } from './storage'
const pending = new Map<string,Promise<void>>()
const failures = new Map<string,unknown>()
const FAILURE_CAPACITY = 300
export function coverFilesRoot(): string { return join(storageRoot(),'local','covers') }
export function coverFilePath(key: string): string { return join(coverFilesRoot(),`${storageKey(key)}.bin`) }
export function coverFileUrl(key: string): string { return `kagi-cover:${storageKey(key)}` }
function queueWrite(path: string, action: () => Promise<void>, failed?: () => void): void {
  const operation: Promise<void> = (pending.get(path) ?? Promise.resolve()).catch(() => undefined).then(action).then(() => {
    failures.delete(path)
  },(error: unknown) => {
    failures.delete(path); failures.set(path,error); failed?.()
    while (failures.size > FAILURE_CAPACITY) { const oldest = failures.keys().next(); if (!oldest.done) failures.delete(oldest.value) }
    throw error
  }).finally(() => { if (pending.get(path) === operation) pending.delete(path) })
  pending.set(path,operation)
  void operation.catch(() => undefined)
}
async function finishWrites(path: string): Promise<void> {
  for (;;) { const operation = pending.get(path); if (!operation) break; await operation }
  if (failures.has(path)) throw failures.get(path)
}
export async function awaitLocalImage(value: string): Promise<string> {
  const path = localFilePath(value)
  if (!path) throw new Error('The image is outside native image storage.')
  await finishWrites(path)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('The local image is not a readable regular file.')
  return path
}
export async function awaitLocalImageReferences(values: readonly unknown[]): Promise<void> {
  const strings = values.filter((value): value is string => typeof value === 'string')
  if (!strings.length) return
  const paths = new Set<string>()
  for (const value of strings) for (const match of value.matchAll(/kagi-cover:([a-f0-9]{64})(?![a-f0-9])/g)) paths.add(join(coverFilesRoot(),`${match[1]}.bin`))
  for (const path of paths) await awaitLocalImage(path)
}
export async function waitForLocalImageIdle(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending.values()])
}
export async function flushLocalImageWrites(paths?: readonly string[]): Promise<void> {
  if (paths) { for (const path of paths) await finishWrites(path); return }
  await waitForLocalImageIdle()
  if (failures.size) throw failures.values().next().value
}
class ObjectUrlCache {
  private readonly urls = new Map<string,string>()
  constructor(private readonly capacity: number) {}
  put(key: string, blob: Blob): string {
    const existing = this.get(key); if (existing) return existing
    const url = URL.createObjectURL(blob); this.urls.set(key,url)
    while (this.urls.size > this.capacity) { const oldest = this.urls.keys().next(); if (!oldest.done) this.drop(oldest.value) }
    return url
  }
  has(key: string): boolean { return this.urls.has(key) }
  get(key: string): string | undefined { const value = this.urls.get(key); if (!value) return undefined; this.urls.delete(key); this.urls.set(key,value); return value }
  drop(key: string): void { const value = this.urls.get(key); this.urls.delete(key); if (value) URL.revokeObjectURL(value) }
  dropPrefix(prefix: string): void { for (const key of this.urls.keys()) if (key.startsWith(prefix)) this.drop(key) }
  clear(): void { for (const key of this.urls.keys()) this.drop(key) }
}
class CoverFileCache {
  private readonly paths = new Map<string,{path:string;url:string}>()
  put(key: string, blob: Blob): string {
    const existing = this.get(key); if (existing) return existing
    const path = coverFilePath(key); const entry = {path,url:coverFileUrl(key)}; this.paths.set(key,entry)
    queueWrite(path,() => atomicWrite(path,blob),() => { if (this.paths.get(key) === entry) this.paths.delete(key) })
    while (this.paths.size > 300) { const oldest = this.paths.keys().next(); if (!oldest.done) this.paths.delete(oldest.value) }
    return entry.url
  }
  has(key: string): boolean { return this.get(key) !== undefined }
  get(key: string): string | undefined {
    const entry = this.paths.get(key); if (!entry) return undefined
    if (!pending.has(entry.path) && !existsSync(entry.path)) { this.paths.delete(key); return undefined }
    this.paths.delete(key); this.paths.set(key,entry); return entry.url
  }
  drop(key: string): void { this.paths.delete(key); const path = coverFilePath(key); queueWrite(path,() => rm(path,{force:true})) }
  dropPrefix(prefix: string): void { for (const key of this.paths.keys()) if (key.startsWith(prefix)) this.drop(key) }
  clear(): void { this.paths.clear() }
}
export const pageUrls = new ObjectUrlCache(600)
export const coverUrls = new CoverFileCache()
export function clearLocalBlobUrls(): void { pageUrls.clear(); coverUrls.clear() }
export async function clearLocalCoverFiles(): Promise<void> {
  await waitForLocalImageIdle()
  coverUrls.clear(); failures.clear()
  await rm(coverFilesRoot(),{recursive:true,force:true})
}
