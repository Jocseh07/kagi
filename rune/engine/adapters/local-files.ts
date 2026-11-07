import { constants } from 'node:fs'
import { lstat, open, readdir, rename, rm, utimes } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js'
import { clearLocalMetadata } from '../../../src/lib/sources/local/metadata'
import { parseComicInfo } from '../../../src/lib/sources/local/comic-info'
import { isArchiveName, isImageName } from '../../../src/lib/sources/local/scan'
import type { LocalLibraryState, LocalLibraryStatus } from '../../../src/lib/sources/local/library'
import { atomicWrite, directoryHandle, ensureDirectory, freePath, isMissing, safeName, storageRoot, syncDirectory } from './storage'
import { clearLocalBlobUrls, coverFilePath, coverUrls, flushLocalImageWrites } from './local-files-urls'
import { importBooksFromPaths } from './local-novel'
import { getPreference, setPreference, deletePreference } from './preferences'
export type { LocalLibraryState, LocalLibraryStatus }
export const LOCAL_LIBRARY_KEY = 'local-library'
const listeners = new Set<() => void>()
const timestamps = new Map<string,number>()
let state: LocalLibraryState = {status:'unset',folderName:null}
let selectedRoot: string | undefined
let chain: Promise<unknown> = Promise.resolve()
let revision = 0
function mutateLocalFiles<T>(action: () => Promise<T>): Promise<T> {
  const result = chain.then(action)
  chain = result.then(() => undefined,() => undefined)
  return result
}
export function localFilesRoot(): string { return join(storageRoot(),'local','comics') }
export function supportsLocalLibrary(): boolean { return true }
export function getLocalLibraryState(): LocalLibraryState { return state }
export function subscribeLocalLibrary(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }
function changed(): void { timestamps.clear(); clearLocalMetadata(); clearLocalBlobUrls(); for (const listener of listeners) listener() }
export async function loadLocalLibrary(): Promise<LocalLibraryState> {
  const mine = revision
  const selected = await getPreference('local.comics.root') || undefined
  const root = selected ?? localFilesRoot()
  let next: LocalLibraryState
  try {
    const info = await lstat(root)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The comic library folder is unavailable.')
    const entries = await readdir(root,{withFileTypes:true})
    next = {status:selected || entries.some((entry) => entry.isDirectory() && !entry.name.startsWith('.')) ? 'ready' : 'unset',folderName:selected ? basename(root) : null}
  } catch (error) {
    if (isMissing(error) && !selected) next = {status:'unset',folderName:null}
    else next = {status:'denied',folderName:basename(root)}
  }
  if (mine !== revision) return state
  selectedRoot = selected; state = next
  return state
}
export async function reconnectLocalLibrary(): Promise<LocalLibraryState> { revision++; const next = await loadLocalLibrary(); changed(); return next }
export async function chooseLocalLibrary(path?: string): Promise<LocalLibraryState> {
  if (!path) throw new Error('Select a comic library folder with the native folder picker.')
  return mutateLocalFiles(async () => {
    const root = resolve(path); const info = await lstat(root)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Choose a readable directory, not a symbolic link.')
    await readdir(root); await setPreference('local.comics.root',root)
    return reconnectLocalLibrary()
  })
}
export async function forgetLocalLibrary(): Promise<LocalLibraryState> {
  return mutateLocalFiles(async () => { await deletePreference('local.comics.root'); return reconnectLocalLibrary() })
}
export function clearImportedComics(): Promise<void> {
  return mutateLocalFiles(async () => {
    let names: string[] = []
    try { names = (await readdir(localFilesRoot(),{withFileTypes:true})).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name) }
    catch (error) { if (!isMissing(error)) throw error }
    await rm(localFilesRoot(),{recursive:true,force:true})
    const paths: string[] = []
    for (const name of names) for (const key of [`cover:${name}`,`first-page:${name}`]) { coverUrls.drop(key); paths.push(coverFilePath(key)) }
    await flushLocalImageWrites(paths)
    await reconnectLocalLibrary()
  })
}
export function deleteLocalSeries(name: string): Promise<LocalLibraryState> {
  return mutateLocalFiles(async () => {
    await rm(join(localFilesRoot(),safeName(name)),{recursive:true,force:true})
    const keys = [`cover:${name}`,`first-page:${name}`]
    for (const key of keys) coverUrls.drop(key)
    await flushLocalImageWrites(keys.map(coverFilePath))
    return reconnectLocalLibrary()
  })
}
export async function getLibraryRoot(): Promise<FileSystemDirectoryHandle | null> {
  await loadLocalLibrary()
  if (state.status === 'denied') return null
  const root = selectedRoot ?? localFilesRoot(); await ensureDirectory(root); return directoryHandle(root)
}
export async function requireLibraryRoot(): Promise<FileSystemDirectoryHandle> {
  const root = await getLibraryRoot(); if (!root) throw new Error('The comic library folder is unavailable. Reconnect it from Browse.'); return root
}
export function getCachedTimestamp(name: string): number | undefined { return timestamps.get(name) }
export function cacheTimestamp(name: string, value: number): void { timestamps.set(name,value) }
export function seriesNameFromFile(name: string): string | null {
  const cleaned = name.replace(/\.[^.]+$/,'').replace(/_/g,' ').replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g,' ').replace(/\s+/g,' ').trim()
  const marker = /(?:^|[\s.-])(?:vol(?:ume)?|ch(?:apter)?|ep(?:isode)?|v(?=\d)|c(?=\d)|#)[\s.]*\d/i.exec(cleaned)
  const head = (marker ? cleaned.slice(0,marker.index) : cleaned.replace(/[\s.-]*\d+(?:\.\d+)?$/,'')).replace(/[\s.-]+$/,'').trim()
  return head && /[^\d\s.-]/.test(head) ? head : null
}
async function copyTree(source: string, destination: string): Promise<void> {
  const info = await lstat(source)
  if (info.isSymbolicLink()) throw new Error('Imported folders cannot contain symbolic links.')
  if (info.isDirectory()) { await ensureDirectory(destination); for (const entry of await readdir(source)) { if (!entry.startsWith('.') || entry === '.noxml') await copyTree(join(source,entry),join(destination,safeName(entry))) } }
  else if (info.isFile()) await atomicWrite(destination,Bun.file(source))
  else throw new Error('Only regular files and directories can be imported.')
  await utimes(destination,info.atime,info.mtime)
  const file = await open(destination,constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await file.sync() } finally { await file.close() }
}
async function archiveSeries(path: string): Promise<string | undefined> {
  const reader = new ZipReader(new BlobReader(Bun.file(path)),{useWebWorkers:false})
  try {
    const entries = await reader.getEntries()
    if (!entries.some((entry) => !entry.directory && isImageName(entry.filename))) throw new Error('The comic archive contains no images.')
    const info = entries.find((entry) => !entry.directory && entry.filename.toLowerCase() === 'comicinfo.xml')
    if (info && !info.directory) return parseComicInfo(await info.getData(new TextWriter()))?.series.title
  } finally { await reader.close() }
}
async function importComicPath(path: string): Promise<void> {
  const root = await ensureDirectory(localFilesRoot()); const info = await lstat(path); const name = safeName(basename(path))
  if (root === resolve(path) || root.startsWith(resolve(path)+'/')) throw new Error('The import folder cannot contain the native comic library.')
  let destination: string
  if (info.isSymbolicLink()) throw new Error('Import the original file, not a symbolic link.')
  if (info.isDirectory()) destination = await freePath(root,name)
  else {
    if (!isArchiveName(name)) throw new Error('Choose a CBZ or ZIP comic archive.')
    const title = (await archiveSeries(path) ?? seriesNameFromFile(name) ?? name.replace(/\.[^.]+$/,'')).replace(/[\\/]/g,'-').replace(/^\.+/,'').trim() || 'Untitled series'
    const series = await ensureDirectory(join(root,safeName(title)))
    destination = await freePath(series,name)
  }
  const staging = join(root,`.import-${crypto.randomUUID()}`)
  try {
    await copyTree(path,staging)
    if (info.isDirectory()) {
      const entries = await readdir(staging,{withFileTypes:true})
      if (entries.some((entry) => entry.isFile() && isImageName(entry.name) && !/^cover\./i.test(entry.name)) && !entries.some((entry) => entry.isDirectory() || isArchiveName(entry.name))) {
        const chapter = join(staging,'Chapter 1'); await ensureDirectory(chapter)
        for (const entry of entries) if (entry.isFile() && isImageName(entry.name) && !/^cover\./i.test(entry.name)) await rename(join(staging,entry.name),join(chapter,entry.name))
        await syncDirectory(chapter)
      }
    }
    await rename(staging,destination)
    await syncDirectory(dirname(destination))
  } catch (error) { await rm(staging,{recursive:true,force:true}); throw error }
}
export function importLocalFiles(paths: string[]): Promise<{imported:number;rejected:string[]}> {
  return mutateLocalFiles(async () => {
    let imported = 0; let comics = 0; const rejected: string[] = []
    for (const selected of paths) {
      const path = resolve(selected)
      try {
        if (/\.(epub|txt|text)$/i.test(path)) { const result = await importBooksFromPaths([path]); imported += result.added.length; rejected.push(...result.rejected) }
        else { await importComicPath(path); imported++; comics++ }
      } catch (error) { rejected.push(`${basename(path)}: ${error instanceof Error ? error.message : String(error)}`) }
    }
    if (comics) await deletePreference('local.comics.root')
    await reconnectLocalLibrary(); return {imported,rejected}
  })
}
export async function importComics(files: readonly {uri:string;name:string}[]): Promise<{imported:number;rejected:string[]}> { return importLocalFiles(files.map((file) => file.uri.startsWith('file:') ? fileURLToPath(file.uri) : file.uri)) }
