/**
 * The imported-books shelf.
 *
 * Books are copied into IndexedDB rather than read from a folder, so the novel
 * source works in every browser instead of only Chromium desktop. Bytes go in
 * IndexedDB and not OPFS because writing to OPFS needs
 * `FileSystemFileHandle.createWritable`, which Safari does not implement.
 *
 * The database is its own (`kagi-novels`), deliberately not `kagi-handles`:
 * `clearOtherData` deletes that whole database and would take the books with
 * it. Two stores, so listing the shelf never inflates a blob into memory.
 */

import { openDB } from 'idb'
import type { DBSchema, IDBPDatabase } from 'idb'

import { coverUrls } from '../local/blob-urls'
import { readEpubStructure } from './epub'
import type { EpubBook } from './epub-package'

export interface NovelBook {
  /** File name, extension included. The source's identity for the book. */
  name: string
  size: number
  /** From the imported File, for display only. */
  lastModified: number
  addedAt: number
}

interface NovelDb extends DBSchema {
  books: { key: string; value: NovelBook }
  blobs: { key: string; value: Blob }
}

const DB_NAME = 'kagi-novels'
const DB_VERSION = 1

const IMPORTABLE = /\.(epub|txt|text)$/i

let dbPromise: Promise<IDBPDatabase<NovelDb>> | undefined

/**
 * Structure of the books read this page load.
 *
 * Reading a spine means inflating the package document, so the series screen,
 * the chapter list and every chapter opened from it would otherwise re-parse
 * the same file.
 */
const structures = new Map<string, EpubBook>()

export function supportsNovelShelf(): boolean {
  return typeof indexedDB !== 'undefined'
}

function getDb(): Promise<IDBPDatabase<NovelDb>> | undefined {
  if (!supportsNovelShelf()) return undefined
  dbPromise ??= openDB<NovelDb>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('books')) {
        db.createObjectStore('books', { keyPath: 'name' })
      }
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs')
      }
    },
  })
  return dbPromise
}

export async function listBooks(): Promise<NovelBook[]> {
  const db = await getDb()
  if (!db) return []
  return await db.getAll('books')
}

/**
 * Copies files onto the shelf, skipping anything that is not a book.
 *
 * A name already on the shelf is deduped to `Book (2).epub` rather than
 * overwritten: the library may already link to the book under that name.
 */
export async function importBooks(
  files: readonly File[],
): Promise<{ added: NovelBook[]; rejected: string[] }> {
  const db = await getDb()
  if (!db) {
    throw new Error('This browser has no storage available for imports.')
  }

  const rejected: string[] = []
  const accepted: File[] = []
  for (const file of files) {
    if (IMPORTABLE.test(file.name)) accepted.push(file)
    else rejected.push(file.name)
  }

  const taken = new Set(await db.getAllKeys('books'))
  const added: NovelBook[] = []

  for (const file of accepted) {
    const name = freeName(file.name, taken)
    taken.add(name)

    const book: NovelBook = {
      name,
      size: file.size,
      lastModified: file.lastModified,
      addedAt: Date.now(),
    }

    const tx = db.transaction(['books', 'blobs'], 'readwrite')
    await Promise.all([
      tx.objectStore('books').put(book),
      tx.objectStore('blobs').put(file.slice(), name),
      tx.done,
    ])

    added.push(book)
  }

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
  const db = await getDb()
  if (!db) return

  const tx = db.transaction(['books', 'blobs'], 'readwrite')
  await Promise.all([
    tx.objectStore('books').delete(name),
    tx.objectStore('blobs').delete(name),
    tx.done,
  ])

  forget(name)
}

export async function clearBooks(): Promise<void> {
  const db = await getDb()
  if (!db) return

  const names = await db.getAllKeys('books')

  const tx = db.transaction(['books', 'blobs'], 'readwrite')
  await Promise.all([
    tx.objectStore('books').clear(),
    tx.objectStore('blobs').clear(),
    tx.done,
  ])

  for (const name of names) forget(name)
}

/** Drops the parsed structure and the cover URL minted against a book. */
function forget(name: string): void {
  structures.delete(name)
  coverUrls.drop(`novel-cover:${name}`)
}

/**
 * The stored bytes as a `File`, which is what `zip.js` and the text reader
 * already take.
 */
export async function readBookFile(name: string): Promise<File> {
  const db = await getDb()
  const record = db ? await db.get('books', name) : undefined
  const blob = db ? await db.get('blobs', name) : undefined
  if (!record || !blob) {
    throw new Error(`"${name}" is no longer in your imported books.`)
  }
  return new File([blob], name, { lastModified: record.lastModified })
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
