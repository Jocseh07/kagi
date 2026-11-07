import { lstat, readdir, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { exec, sqliteTransaction } from './database'
import { atomicWrite, freePath, isMissing, safeName, storageRoot } from './storage'
import { coverFilePath, coverUrls, flushLocalImageWrites } from './local-files-urls'
import { readEpubStructure } from '../../../src/lib/sources/local-novel/epub'
import type { EpubBook } from '../../../src/lib/sources/local-novel/epub-package'
import type { NovelBook } from '../../../src/lib/sources/local-novel/shelf'
export type { NovelBook }
const structures = new Map<string,EpubBook>()
let imports: Promise<unknown> = Promise.resolve()
function mutateNovelShelf<T>(action: () => Promise<T>): Promise<T> {
  const result = imports.then(action)
  imports = result.then(() => undefined,() => undefined)
  return result
}
export function novelsRoot(): string { return join(storageRoot(),'local','novels') }
export function supportsNovelShelf(): boolean { return true }
export async function listBooks(): Promise<NovelBook[]> { return (await exec('SELECT data FROM native_novels ORDER BY id')).rows.map((row) => JSON.parse(String(row[0])) as NovelBook) }
export function importBooks(files: readonly File[]): Promise<{added:NovelBook[];rejected:string[]}> {
  return mutateNovelShelf(async () => {
    const added: NovelBook[] = []; const rejected: string[] = []
    for (const file of files) {
      if (!/\.(epub|txt|text)$/i.test(file.name)) { rejected.push(file.name); continue }
      safeName(file.name)
      const destination = await freePath(novelsRoot(),file.name)
      const book: NovelBook = {name:basename(destination),size:file.size,lastModified:file.lastModified,addedAt:Date.now()}
      await atomicWrite(destination,file)
      try { await exec('INSERT INTO native_novels(id,data,path) VALUES (?,?,?)',[book.name,JSON.stringify(book),book.name]) }
      catch (error) { await rm(destination,{force:true}); throw error }
      added.push(book)
    }
    return {added,rejected}
  })
}
export async function importBooksFromPaths(paths: readonly string[]): Promise<{added:NovelBook[];rejected:string[]}> {
  const files: File[] = []; const rejected: string[] = []
  for (const selected of paths) {
    const path = resolve(selected)
    if (!/\.(epub|txt|text)$/i.test(path)) { rejected.push(basename(path)); continue }
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) { rejected.push(basename(path)); continue }
    files.push(new File([Bun.file(path)],basename(path),{lastModified:info.mtimeMs}))
  }
  const result = await importBooks(files); return {added:result.added,rejected:[...rejected,...result.rejected]}
}
export function deleteBook(name: string): Promise<void> { return mutateNovelShelf(() => removeBook(name)) }
async function removeBook(name: string): Promise<void> {
  safeName(name)
  const path = await sqliteTransaction(async () => {
    const row = (await exec('SELECT path FROM native_novels WHERE id = ?',[name])).rows[0]
    await exec('DELETE FROM native_novels WHERE id = ?',[name]); return row ? String(row[0]) : name
  })
  structures.delete(name); coverUrls.drop(`novel-cover:${name}`)
  await rm(join(novelsRoot(),safeName(path)),{force:true})
  await flushLocalImageWrites([coverFilePath(`novel-cover:${name}`)])
}
export function clearBooks(): Promise<void> {
  return mutateNovelShelf(async () => {
    const books = await listBooks()
    const known = new Set(books.map((book) => book.name))
    let names: string[] = []
    try { names = await readdir(novelsRoot()) } catch (error) { if (!isMissing(error)) throw error }
    for (const book of books) await removeBook(book.name)
    const paths: string[] = []
    for (const name of names) if (!known.has(name) && /\\.(epub|txt|text)$/i.test(name)) { const key = `novel-cover:${name}`; coverUrls.drop(key); paths.push(coverFilePath(key)) }
    await flushLocalImageWrites(paths)
    await rm(novelsRoot(),{recursive:true,force:true})
  })
}
export async function readBookFile(name: string): Promise<File> {
  const row = (await exec('SELECT data,path FROM native_novels WHERE id = ?',[name])).rows[0]
  if (!row) throw new Error(`"${name}" is no longer in your imported books.`)
  const record = JSON.parse(String(row[0])) as NovelBook
  const path = join(novelsRoot(),safeName(String(row[1])))
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('The imported book is not a readable regular file.')
  return new File([Bun.file(path)],name,{lastModified:record.lastModified})
}
export async function readStructure(name: string): Promise<EpubBook> {
  const cached = structures.get(name); if (cached) return cached
  const book = await readEpubStructure(await readBookFile(name)); structures.set(name,book); return book
}
export async function shelfSize(): Promise<{bytes:number;count:number}> { const books = await listBooks(); return {bytes:books.reduce((total,book) => total+book.size,0),count:books.length} }
export function clearNovelCaches(): void {
  coverUrls.clear()
  structures.clear()
}
