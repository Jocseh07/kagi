/**
 * The imported-books shelf on native.
 *
 * Books are copied into `<documents>/local/novels`, one file per book under
 * the name the source knows it by. A small index beside the folder keeps what
 * the files themselves cannot: the date the user's own copy had and when it
 * was added. A book missing from the index is still listed, dated by its file.
 */

import { strToU8 } from 'fflate'

import {
  asWebFile,
  childFile,
  deleteIfExists,
  ensureDirectory,
  entryName,
  fileAt,
  listEntries,
  localDocumentsRoot,
  novelsRoot,
  writeBytes,
} from '@/lib/storage/native-files'
import type { PickedFile } from '@/lib/storage/native-files'
import { File } from 'expo-file-system'

import { coverUrls } from '../local/blob-urls'
import { novelCacheDirectory, readEpubStructure } from './epub'
import type { EpubBook } from './epub-package'

export interface NovelBook {
  /** File name, extension included. The source's identity for the book. */
  name: string
  size: number
  /** From the imported file, for display only. */
  lastModified: number
  addedAt: number
}

interface IndexRecord {
  lastModified: number
  addedAt: number
}

type ShelfIndex = Record<string, IndexRecord>

const IMPORTABLE = /\.(epub|txt|text)$/i

/** Parsed structure of the books read this session; see the web shelf. */
const structures = new Map<string, EpubBook>()

export function supportsNovelShelf(): boolean {
  return true
}

function indexFile(): File {
  return new File(localDocumentsRoot(), 'novels.json')
}

function readIndex(): ShelfIndex {
  const file = indexFile()
  if (!file.exists) return {}
  try {
    const parsed: unknown = JSON.parse(file.textSync())
    return parsed && typeof parsed === 'object' ? (parsed as ShelfIndex) : {}
  } catch {
    return {}
  }
}

function writeIndex(index: ShelfIndex): void {
  writeBytes(indexFile(), strToU8(JSON.stringify(index)))
}

function bookFiles(): File[] {
  return listEntries(novelsRoot()).filter(
    (entry): entry is File => entry instanceof File && IMPORTABLE.test(entryName(entry)),
  )
}

export async function listBooks(): Promise<NovelBook[]> {
  const index = readIndex()
  return bookFiles().map((file) => {
    const name = entryName(file)
    const record = index[name]
    const fallback = file.lastModified ?? 0
    return {
      name,
      size: file.size,
      lastModified: record?.lastModified ?? fallback,
      addedAt: record?.addedAt ?? fallback,
    }
  })
}

/**
 * Copies picked files onto the shelf, skipping anything that is not a book.
 *
 * A name already on the shelf is deduped to `Book (2).epub` rather than
 * overwritten: the library may already link to the book under that name.
 */
export async function importBooks(
  files: readonly PickedFile[],
): Promise<{ added: NovelBook[]; rejected: string[] }> {
  const directory = ensureDirectory(novelsRoot())
  const index = readIndex()
  const taken = new Set(bookFiles().map(entryName))

  const rejected: string[] = []
  const added: NovelBook[] = []

  for (const picked of files) {
    if (!IMPORTABLE.test(picked.name)) {
      rejected.push(picked.name)
      continue
    }

    const name = freeName(picked.name, taken)
    const target = childFile(directory, name)
    try {
      await fileAt(picked.uri).copy(target)
    } catch {
      deleteIfExists(target)
      rejected.push(picked.name)
      continue
    }
    taken.add(name)

    const book: NovelBook = {
      name,
      size: target.size,
      lastModified: picked.lastModified ?? target.lastModified ?? Date.now(),
      addedAt: Date.now(),
    }
    index[name] = { lastModified: book.lastModified, addedAt: book.addedAt }
    added.push(book)
  }

  if (added.length > 0) writeIndex(index)
  return { added, rejected }
}

/** `Book.epub` → `Book (2).epub` → `Book (3).epub`, until one is free. */
function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name

  const dot = name.lastIndexOf('.')
  const stem = dot === -1 ? name : name.slice(0, dot)
  const extension = dot === -1 ? '' : name.slice(dot)

  for (let n = 2; ; n += 1) {
    const candidate = `${stem} (${n})${extension}`
    if (!taken.has(candidate)) return candidate
  }
}

export async function deleteBook(name: string): Promise<void> {
  deleteIfExists(childFile(novelsRoot(), name))
  const index = readIndex()
  if (name in index) {
    delete index[name]
    writeIndex(index)
  }
  forget(name)
}

export async function clearBooks(): Promise<void> {
  const names = bookFiles().map(entryName)
  deleteIfExists(novelsRoot())
  deleteIfExists(indexFile())
  for (const name of names) forget(name)
}

/** Drops the parsed structure and the cover extracted from a book. */
function forget(name: string): void {
  structures.delete(name)
  coverUrls.drop(`novel-cover:${name}`)
  deleteIfExists(novelCacheDirectory(name))
}

/** The stored book in the shape of a web `File`, dated as the user's copy was. */
export async function readBookFile(name: string): Promise<globalThis.File> {
  const file = childFile(novelsRoot(), name)
  if (!file.exists) {
    throw new Error(`"${name}" is no longer in your imported books.`)
  }
  return asWebFile(file, name, readIndex()[name]?.lastModified ?? file.lastModified ?? 0)
}

export async function readStructure(name: string): Promise<EpubBook> {
  const cached = structures.get(name)
  if (cached) return cached
  const book = await readEpubStructure(await readBookFile(name))
  structures.set(name, book)
  return book
}

export async function shelfSize(): Promise<{ bytes: number; count: number }> {
  const books = await listBooks()
  let bytes = 0
  for (const book of books) bytes += book.size
  return { bytes, count: books.length }
}
