import { existsSync } from 'node:fs'
import { lstat, readdir, rename, rm, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { deleteSavedChapterRows, getChapterPages, getSetting, listSavedChapters, listUnverifiedChapterIds, markChapterSaved, markChapterVerified, saveChapterPages, setChapterSavedBytes, setSetting } from '../../../src/lib/db/repositories'
import type { Page } from '../../../src/lib/sources/types'
import { DEFAULT_SAVED_CHAPTER_LIMIT, MAX_SAVED_CHAPTER_LIMIT, SAVED_CHAPTER_LIMIT_UNLIMITED, SETTING_SAVED_CHAPTER_LIMIT, SUSPEND_ABORT_REASON } from '../../../src/lib/offline/types'
import type { SaveChapterResult, SaveOptions } from '../../../src/lib/offline/types'
import { exec, nativeDatabase, sqliteTransaction } from './database'
import { atomicWrite, ensureDirectory, isMissing, localFilePath, readBytes, storageFailure, storageKey, storageRoot, syncDirectory } from './storage'
import { cacheSourceImage, imageInfo } from './image-runtime'
const MIN_FREE_BYTES = 200*1024*1024
const active = new Map<string,{controller:AbortController;promise:Promise<SaveChapterResult>;committed:boolean}>()
const deleting = new Map<string,Promise<void>>()
let clearing: Promise<void> | undefined
let sweeping = false
let trimming: Promise<unknown> = Promise.resolve()
export function offlineRoot(): string { return join(storageRoot(),'offline') }
export function chapterDirectory(chapterId: string): string { return join(offlineRoot(),storageKey(chapterId)) }
export function supportsOfflineSave(): boolean { return true }
export function offlinePagePath(chapterId: string, index: number): string | undefined {
  const statement = nativeDatabase().prepare('SELECT url FROM chapter_pages WHERE chapter_id = ? AND "index" = ?')
  try {
    const row = statement.get(chapterId,index) as {url:string} | null
    const path = row ? localFilePath(row.url) : undefined
    return path?.startsWith(chapterDirectory(chapterId)+'/') && existsSync(path) ? path : undefined
  } finally { statement.finalize() }
}
export async function backgroundDownloadsAvailable(): Promise<boolean> { return false }
export function cancelNativeOfflineJob(chapterId: string, reason: unknown = 'cancelled'): void { active.get(chapterId)?.controller.abort(reason) }
export async function runNativeOfflineJob(chapterId: string, options: SaveOptions, run: (options: SaveOptions) => Promise<SaveChapterResult>): Promise<SaveChapterResult> {
  for (;;) { const wait = clearing ?? deleting.get(chapterId); if (!wait) break; await wait }
  const existing = active.get(chapterId); if (existing) return existing.promise
  if (options.signal?.aborted) return {ok:false,reason:'cancelled',message:'Saving was cancelled.'}
  const controller = new AbortController(); const onAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort',onAbort,{once:true})
  const promise = Promise.resolve().then(() => run({...options,signal:controller.signal})).finally(() => { options.signal?.removeEventListener('abort',onAbort); if (active.get(chapterId)?.controller === controller) active.delete(chapterId) })
  active.set(chapterId,{controller,promise,committed:false}); return promise
}
export function markNativeOfflineJobCommitted(chapterId: string): void {
  const job = active.get(chapterId); if (!job) throw new Error('The native save job is no longer active.')
  job.committed = true
}
export async function saveChapter(chapterId: string, pages: readonly Page[], options: SaveOptions = {}): Promise<SaveChapterResult> {
  if (!pages.length) return {ok:false,reason:'no-pages',message:'This chapter has no pages, so there is nothing to save.'}
  if (pages.some((page) => !Number.isSafeInteger(page.index) || page.index < 0) || new Set(pages.map((page) => page.index)).size !== pages.length) return {ok:false,reason:'network',message:'The chapter returned invalid or duplicate page indexes.'}
  return runNativeOfflineJob(chapterId,options,(next) => runSave(chapterId,pages,next))
}
async function runSave(chapterId: string, pages: readonly Page[], options: SaveOptions): Promise<SaveChapterResult> {
  const root = chapterDirectory(chapterId); const staging = join(root,'pending'); const manifest = join(staging,'manifest.json')
  const identity = JSON.stringify(pages.map((page) => [page.index,page.imageUrl,page.descramble]))
  let position = 0; let phase: 'fetching' | 'verifying' | 'persisting' = 'fetching'; let committed = false; let final: string | undefined
  let measuredBytes = 0
  try {
    const source = (await exec('SELECT m.source_id FROM chapters c JOIN manga m ON m.id = c.manga_id WHERE c.id = ?',[chapterId])).rows[0]
    if (!source) throw new Error('The chapter is no longer in the library.')
    try { if (new TextDecoder().decode(await readBytes(manifest)) !== identity) await rm(staging,{recursive:true,force:true}) }
    catch (error) { if (!isMissing(error)) throw error }
    await ensureDirectory(staging); await atomicWrite(manifest,identity)
    options.onProgress?.({phase:'fetching',completed:0,total:pages.length})
    let previousStart = 0
    for (const [index,page] of pages.entries()) {
      position = index; options.signal?.throwIfAborted()
      const destination = join(staging,`${page.index}.png`)
      let reusable = false
      try { const info = await imageInfo(destination); reusable = info.width > 0 && info.height > 0 } catch (error) { if (!isMissing(error)) await rm(destination,{force:true}) }
      if (!reusable) {
        const disk = await statfs(staging)
        if (disk.bavail*disk.bsize < MIN_FREE_BYTES) throw Object.assign(new Error('Not enough free disk space.'),{code:'ENOSPC'})
        const wait = previousStart+(options.minIntervalMs ?? 0)-Date.now()
        if (wait > 0) await delay(wait,undefined,{signal:options.signal})
        previousStart = Date.now()
        const image = await cacheSourceImage(String(source[0]),page,options.signal)
        options.signal?.throwIfAborted()
        await atomicWrite(destination,Bun.file(image.path))
      }
      options.onProgress?.({phase:'fetching',completed:index+1,total:pages.length})
    }
    phase = 'verifying'; options.onProgress?.({phase:'verifying',completed:0,total:pages.length})
    let bytes = 0
    for (const [index,page] of pages.entries()) {
      position = index; options.signal?.throwIfAborted(); const path = join(staging,`${page.index}.png`)
      const info = await imageInfo(path); if (info.width < 1 || info.height < 1) throw new Error('The saved page is not a readable image.')
      bytes += (await lstat(path)).size; options.onProgress?.({phase:'verifying',completed:index+1,total:pages.length})
    }
    measuredBytes = bytes
    options.signal?.throwIfAborted(); phase = 'persisting'
    final = join(root,crypto.randomUUID()); await rename(staging,final)
    await syncDirectory(root)
    const prefix = `kagi-offline:${storageKey(chapterId)}/${final.slice(root.length+1)}/`
    const saved = pages.map((page) => ({index:page.index,imageUrl:`${prefix}${page.index}.png`}))
    await sqliteTransaction(async () => {
      options.signal?.throwIfAborted()
      await saveChapterPages(chapterId,saved)
      if (!await markChapterSaved(chapterId,true,true)) throw new Error('The chapter was removed before it could be saved.')
      await setChapterSavedBytes(chapterId,bytes)
      options.signal?.throwIfAborted()
    })
    committed = true
    markNativeOfflineJobCommitted(chapterId)
    for (const entry of await readdir(root,{withFileTypes:true})) if (entry.isDirectory() && entry.name !== final.slice(root.length+1)) await rm(join(root,entry.name),{recursive:true,force:true})
    await enforceSavedChapterLimit(chapterId)
    return {ok:true,pageCount:pages.length,projectedBytes:bytes,measuredBytes:bytes}
  } catch (error) {
    if (!committed && final) await rm(final,{recursive:true,force:true})
    if (!committed && options.signal?.reason !== SUSPEND_ABORT_REASON) await rm(staging,{recursive:true,force:true})
    if (committed) {
      console.error('Saved chapter cleanup failed:',error instanceof Error ? error.message : String(error))
      return {ok:true,pageCount:pages.length,projectedBytes:measuredBytes,measuredBytes}
    }
    if (options.signal?.aborted) return {ok:false,reason:'cancelled',message:'Saving was cancelled.'}
    const failure = storageFailure(error)
    if (failure.quota) {
      const evicted = await evictOldestIfCapped(chapterId)
      return {ok:false,reason:'quota-exceeded',pageIndex:position,message:`Storage ran out after ${position} of ${pages.length} pages.${evicted ? ` The oldest saved chapter (${evicted}) was removed. Try again.` : ' Remove saved chapters in Settings, Downloads, then try again.'}`}
    }
    return {ok:false,reason:phase === 'verifying' ? 'verify-failed' : 'network',pageIndex:position,message:`Page ${position+1} of ${pages.length}: ${failure.message}`}
  }
}
export async function unsaveChapter(chapterId: string): Promise<void> {
  const pending = deleting.get(chapterId); if (pending) return pending
  const job = active.get(chapterId); job?.controller.abort('cancelled')
  const removal = (async () => {
    if (job) await job.promise
    await removeSavedChapter(chapterId)
  })().finally(() => deleting.delete(chapterId))
  deleting.set(chapterId,removal); return removal
}
async function removeSavedChapter(chapterId: string): Promise<void> {
  await deleteSavedChapterRows(chapterId)
  await rm(chapterDirectory(chapterId),{recursive:true,force:true})
}
export async function unsaveAllChapters(): Promise<void> {
  if (clearing) return clearing
  clearing = Promise.resolve().then(async () => {
    for (const id of active.keys()) cancelNativeOfflineJob(id)
    await Promise.all([...active.values()].map((job) => job.promise))
    for (const entry of await listSavedChapters()) await unsaveChapter(entry.chapterId)
    await rm(offlineRoot(),{recursive:true,force:true})
  }).finally(() => { clearing = undefined })
  return clearing
}
export async function isChapterSaved(chapterId: string): Promise<boolean> { return (await listSavedChapters()).some((entry) => entry.chapterId === chapterId) }
export async function getSavedChapterLimit(): Promise<number> {
  const value = Number.parseInt(await getSetting(SETTING_SAVED_CHAPTER_LIMIT) ?? '',10)
  return Number.isFinite(value) ? value <= 0 ? SAVED_CHAPTER_LIMIT_UNLIMITED : Math.min(MAX_SAVED_CHAPTER_LIMIT,value) : DEFAULT_SAVED_CHAPTER_LIMIT
}
export async function setSavedChapterLimit(value: number): Promise<number> {
  const limit = Number.isFinite(value) ? value <= 0 ? SAVED_CHAPTER_LIMIT_UNLIMITED : Math.min(MAX_SAVED_CHAPTER_LIMIT,Math.trunc(value)) : DEFAULT_SAVED_CHAPTER_LIMIT
  await setSetting(SETTING_SAVED_CHAPTER_LIMIT,String(limit)); return limit
}
export function enforceSavedChapterLimit(keepChapterId: string): Promise<void> {
  const result = trimming.then(async () => {
    const limit = await getSavedChapterLimit(); if (limit === SAVED_CHAPTER_LIMIT_UNLIMITED) return
    let saved = await listSavedChapters()
    while (saved.length > limit) {
      const oldest = saved.find((entry) => entry.chapterId !== keepChapterId && (!active.has(entry.chapterId) || active.get(entry.chapterId)!.committed)); if (!oldest) return
      await removeSavedChapter(oldest.chapterId); saved = saved.filter((entry) => entry.chapterId !== oldest.chapterId)
    }
  })
  trimming = result.catch(() => undefined); return result
}
async function evictOldestIfCapped(except: string): Promise<string | null> {
  try {
    if (await getSavedChapterLimit() === SAVED_CHAPTER_LIMIT_UNLIMITED) return null
    const oldest = (await listSavedChapters()).find((entry) => entry.chapterId !== except && (!active.has(entry.chapterId) || active.get(entry.chapterId)!.committed))
    if (!oldest) return null
    await removeSavedChapter(oldest.chapterId); return `${oldest.mangaTitle}: ${oldest.chapterName}`
  } catch (error) {
    console.error('Quota eviction failed:',error instanceof Error ? error.message : String(error))
    return null
  }
}
export async function verifyPendingChapters(): Promise<void> {
  if (sweeping) return
  sweeping = true
  try {
    for (const id of await listUnverifiedChapterIds()) {
      if (active.has(id)) continue
      const pages = await getChapterPages(id); let valid = pages.length > 0
      for (const page of pages) {
        try { const path = localFilePath(page.imageUrl); if (!path) { valid = false; break }; const info = await imageInfo(path); if (info.width < 1 || info.height < 1) valid = false }
        catch { valid = false }
        if (!valid) break
      }
      if (valid) await markChapterVerified(id); else await unsaveChapter(id)
    }
  } finally { sweeping = false }
}
