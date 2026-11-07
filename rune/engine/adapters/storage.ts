import { constants } from 'node:fs'
import { access, chmod, lstat, mkdir, open, readdir, rm, statfs } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configureDatabase, dataRoot } from './database'
import type { StorageUsage, PersistOutcome, PersistPermission } from '../../../src/lib/storage/persist'
import { atomicExport } from '../services/files'
export type { StorageUsage, PersistOutcome, PersistPermission }
export function configureStorage(root: string): void { configureDatabase(root) }
export function storageRoot(): string { return dataRoot() }
export function storageKey(key: string): string { return createHash('sha256').update(key).digest('hex') }
export function localFilePath(value: string): string | undefined {
  if (value.startsWith('kagi-cover:')) {
    const match = /^kagi-cover:([a-f0-9]{64})$/.exec(value)
    if (!match) throw new Error('Invalid native cover URL.')
    return join(dataRoot(),'local','covers',`${match[1]}.bin`)
  }
  if (value.startsWith('kagi-offline:')) {
    const match = /^kagi-offline:([a-f0-9]{64})\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/(0|[1-9]\d*)\.png$/i.exec(value)
    if (!match || !Number.isSafeInteger(Number(match[3]))) throw new Error('Invalid native offline page URL.')
    return join(dataRoot(),'offline',match[1],match[2],`${match[3]}.png`)
  }
  const path = value.startsWith('file:') ? fileURLToPath(value) : isAbsolute(value) ? resolve(value) : undefined
  if (!path) return undefined
  const root = dataRoot()+'/'
  if (!path.startsWith(root)) return undefined
  const relative = path.slice(root.length)
  return ['local/','offline/','image-cache/'].some((prefix) => relative.startsWith(prefix)) ? path : undefined
}
export function safeName(name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) throw new Error('Unsafe file name.')
  return name
}
export interface StorageFailure { message: string; quota: boolean }
export function storageFailure(error: unknown): StorageFailure {
  const quotaPattern = /ENOSPC|EDQUOT|SQLITE_FULL|QuotaExceededError|database or disk is full|disk (?:is )?full/i
  let message = 'Storage could not be updated. Check disk space and file permissions.'
  let quota = false; let current = error
  const seen = new Set<unknown>()
  for (let depth = 0; depth < 8 && current !== undefined && !seen.has(current); depth++) {
    seen.add(current)
    if (typeof current === 'string') { message = current; quota ||= quotaPattern.test(current); break }
    if (typeof current !== 'object' || current === null) break
    if ('message' in current && typeof current.message === 'string' && current.message.trim()) { message = current.message.trim(); quota ||= quotaPattern.test(message) }
    if ('code' in current && typeof current.code === 'string') quota ||= quotaPattern.test(current.code)
    if ('name' in current && typeof current.name === 'string') quota ||= quotaPattern.test(current.name)
    current = 'cause' in current ? current.cause : undefined
  }
  return {message,quota}
}
export async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path,constants.O_RDONLY | constants.O_DIRECTORY)
  try { await directory.sync() } finally { await directory.close() }
}
export async function ensureDirectory(path: string): Promise<string> {
  const created = await mkdir(path,{recursive:true,mode:0o700})
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe storage directory.')
  if (created) {
    const stop = dirname(created)
    for (let current = path; ; current = dirname(current)) { await syncDirectory(current); if (current === stop) break }
  }
  return path
}
export async function atomicWrite(path: string, data: string | Uint8Array | Blob): Promise<void> {
  await ensureDirectory(dirname(path))
  await atomicExport(path,data)
}
export async function readBytes(path: string): Promise<Uint8Array<ArrayBuffer>> {
  const file = await open(path,constants.O_RDONLY | constants.O_NOFOLLOW)
  try { return new Uint8Array(await file.readFile()) } finally { await file.close() }
}
export function isMissing(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT' }
export async function freePath(directory: string, name: string): Promise<string> {
  safeName(name); const dot = name.lastIndexOf('.'); const stem = dot > 0 ? name.slice(0,dot) : name; const suffix = dot > 0 ? name.slice(dot) : ''
  for (let index = 1; ; index++) {
    const candidate = join(directory,index === 1 ? name : `${stem} (${index})${suffix}`)
    try { await lstat(candidate) } catch (error) { if (isMissing(error)) return candidate; throw error }
  }
}
export function supportsOpfs(): boolean { return true }
export function blobPath(key: string): string { return join(dataRoot(),'blob-cache',storageKey(key)) }
export async function getBlob(key: string): Promise<Blob | null> { try { return new Blob([await readBytes(blobPath(key))]) } catch (error) { if (isMissing(error)) return null; throw error } }
export async function hasBlob(key: string): Promise<boolean> { try { return (await lstat(blobPath(key))).isFile() } catch (error) { if (isMissing(error)) return false; throw error } }
export async function putBlob(key: string, blob: Blob): Promise<boolean> { await atomicWrite(blobPath(key),blob); return true }
export async function deleteBlob(key: string): Promise<boolean> { try { await rm(blobPath(key)); return true } catch (error) { if (isMissing(error)) return false; throw error } }
export async function clearBlobs(): Promise<void> { await rm(join(dataRoot(),'blob-cache'),{recursive:true,force:true}) }
export function supportsPersistence(): boolean { return true }
export function supportsEstimate(): boolean { return true }
export async function isPersisted(): Promise<boolean> {
  try { await access(dataRoot(),constants.R_OK | constants.W_OK); return (await lstat(dataRoot())).isDirectory() }
  catch (error) { if (isMissing(error)) return false; throw error }
}
export async function requestPersistence(): Promise<PersistOutcome> { await ensureDirectory(dataRoot()); await chmod(dataRoot(),0o700); return 'granted' }
export async function persist(): Promise<boolean> { return (await requestPersistence()) === 'granted' }
export async function permissionState(): Promise<PersistPermission> {
  try { await access(dataRoot(),constants.R_OK | constants.W_OK); return 'granted' }
  catch (error) { if (isMissing(error)) return 'prompt'; return 'denied' }
}
export async function directorySize(path: string): Promise<{bytes:number;count:number}> {
  let bytes = 0; let count = 0
  let entries
  try { entries = await readdir(path,{withFileTypes:true}) } catch (error) { if (isMissing(error)) return {bytes,count}; throw error }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const child = join(path,entry.name)
    if (entry.isDirectory()) { const size = await directorySize(child); bytes += size.bytes; count += size.count }
    else if (entry.isFile()) { bytes += (await lstat(child)).size; count++ }
  }
  return {bytes,count}
}
export async function estimate(): Promise<StorageUsage | null> {
  try { const disk = await statfs(dataRoot()); const usage = (await directorySize(dataRoot())).bytes; const quota = disk.bavail*disk.bsize+usage; return {usage,quota,ratio:quota > 0 ? usage/quota : 0} }
  catch (error) { if (isMissing(error)) return null; throw error }
}
export function directoryHandle(path: string): FileSystemDirectoryHandle {
  const root = resolve(path)
  const handle = {
    kind:'directory' as const,name:basename(root),path:root,
    async getDirectoryHandle(name: string, options?: {create?:boolean}) {
      const child = join(root,safeName(name)); if (options?.create) await ensureDirectory(child)
      const info = await lstat(child); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Not a readable directory.')
      return directoryHandle(child)
    },
    async getFileHandle(name: string, options?: {create?:boolean}) {
      const child = join(root,safeName(name))
      if (options?.create) { const file = await open(child,constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,0o600); await file.close() }
      const info = await lstat(child); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Not a readable file.')
      return fileHandle(child)
    },
    async *entries() {
      for (const entry of await readdir(root,{withFileTypes:true})) {
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) yield [entry.name,directoryHandle(join(root,entry.name))] as const
        else if (entry.isFile()) yield [entry.name,fileHandle(join(root,entry.name))] as const
      }
    },
    async removeEntry(name: string, options?: {recursive?:boolean}) { await rm(join(root,safeName(name)),{recursive:options?.recursive ?? false}) },
    async isSameEntry(other: unknown) { return !!other && typeof other === 'object' && 'path' in other && other.path === root },
    async resolve(other: unknown) { if (!other || typeof other !== 'object' || !('path' in other) || typeof other.path !== 'string') return null; return other.path.startsWith(root+'/') ? other.path.slice(root.length+1).split('/') : other.path === root ? [] : null },
    async queryPermission(options?: {mode?:'read' | 'readwrite'}) {
      try { await access(root,options?.mode === 'readwrite' ? constants.R_OK | constants.W_OK : constants.R_OK); return 'granted' as const } catch { return 'denied' as const }
    },
    async requestPermission(options?: {mode?:'read' | 'readwrite'}) {
      try { await access(root,options?.mode === 'readwrite' ? constants.R_OK | constants.W_OK : constants.R_OK); return 'granted' as const } catch { return 'denied' as const }
    },
  }
  return handle as unknown as FileSystemDirectoryHandle
}
export function fileHandle(path: string): FileSystemFileHandle {
  return {kind:'file',name:basename(path),path,
    async getFile() {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Not a readable regular file.')
      return new File([Bun.file(path)],basename(path),{lastModified:info.mtimeMs})
    },
    async isSameEntry(other: unknown) { return !!other && typeof other === 'object' && 'path' in other && other.path === path },
  } as unknown as FileSystemFileHandle
}
