/**
 * Reading Mihon's local-source layout off a directory handle.
 *
 *   <root>/<Series Title>/<Chapter Name>.cbz     archive chapter
 *   <root>/<Series Title>/<Chapter Name>/001.jpg folder-of-images chapter
 *   <root>/<Series Title>/cover.jpg              optional
 *   <root>/<Series Title>/ComicInfo.xml          optional, preferred
 *   <root>/<Series Title>/details.json           optional, deprecated
 *
 * A folder synced from a phone should work here unchanged, so nothing about a
 * series is required: a folder with nothing but numbered images in it is still
 * a readable series.
 *
 * Mihon also reads CBR/RAR, CB7/7z, CBT/TAR and EPUB chapters. Unpacking those
 * in a browser would mean bundling an unrar or 7z build for a format the app
 * has no other use for, so they are listed but marked unsupported rather than
 * hidden — a chapter missing from the list looks like a sync failure, and the
 * user is the only one who can convert the file.
 */

import type { MangaStatus } from '../types'

const IMAGE_EXTENSIONS = new Set([
  'avif',
  'bmp',
  'gif',
  'jpeg',
  'jpg',
  'jxl',
  'png',
  'webp',
])

const ARCHIVE_EXTENSIONS = new Set(['cbz', 'zip'])

/** Chapter containers Mihon opens and this source cannot. */
const UNSUPPORTED_EXTENSIONS = new Map([
  ['cbr', 'RAR'],
  ['rar', 'RAR'],
  ['cb7', '7z'],
  ['7z', '7z'],
  ['cbt', 'TAR'],
  ['tar', 'TAR'],
  ['epub', 'EPUB'],
])

const DETAILS_FILE = 'details.json'
const COVER_STEM = 'cover'

/**
 * `entries()` is not in the `DOM` lib this project compiles against (it lives
 * in `DOM.AsyncIterable`), and it is missing entirely on engines without the
 * File System Access API, so it is reached through a structural type and
 * checked at runtime.
 */
interface DirectoryIteration {
  entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>
}

export interface DirectoryListing {
  files: Map<string, FileSystemFileHandle>
  directories: Map<string, FileSystemDirectoryHandle>
}

export interface SeriesEntry {
  name: string
  handle: FileSystemDirectoryHandle
}

export type ChapterKind = 'archive' | 'directory' | 'unsupported'

export interface ChapterEntry {
  /** The on-disk entry name, extension included. Identifies the chapter. */
  entryName: string
  /** Display name: the entry name without its archive extension. */
  name: string
  kind: ChapterKind
  handle: FileSystemFileHandle | FileSystemDirectoryHandle
}

export interface LocalDetails {
  title?: string
  author?: string
  artist?: string
  description?: string
  genre?: string[]
  status?: MangaStatus
}

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

/** "Chapter 9" before "Chapter 10", which a plain string sort gets wrong. */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b)
}

export function isHidden(name: string): boolean {
  return name.startsWith('.')
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

export function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? name : name.slice(0, dot)
}

export function isImageName(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(name))
}

export function isArchiveName(name: string): boolean {
  return ARCHIVE_EXTENSIONS.has(extensionOf(name))
}

/** A chapter container Mihon reads that this source has no unpacker for. */
export function isUnsupportedArchiveName(name: string): boolean {
  return UNSUPPORTED_EXTENSIONS.has(extensionOf(name))
}

/**
 * Why a chapter cannot be opened, in the user's terms.
 *
 * Says what the file is and what to do about it: the only fix is converting it
 * outside the app, so naming the format is the whole message.
 */
export function unsupportedFormatMessage(entryName: string): string {
  const extension = extensionOf(entryName)
  const format = UNSUPPORTED_EXTENSIONS.get(extension) ?? extension.toUpperCase()
  return `"${entryName}" is a ${format} archive, which this browser cannot unpack. Convert it to .cbz to read it here.`
}

/** Short enough for the chapter list's one-line subtitle. */
export function unsupportedFormatLabel(entryName: string): string {
  return `Unsupported .${extensionOf(entryName)} format`
}

export function imageMimeType(name: string): string {
  const extension = extensionOf(name)
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'jxl') return 'image/jxl'
  if (extension === 'svg') return 'image/svg+xml'
  return extension ? `image/${extension}` : 'application/octet-stream'
}

/** One pass over a directory, splitting files from subdirectories. Hidden entries are dropped. */
export async function listDirectory(
  dir: FileSystemDirectoryHandle,
): Promise<DirectoryListing> {
  const listing: DirectoryListing = {
    files: new Map(),
    directories: new Map(),
  }

  const iterate = (dir as FileSystemDirectoryHandle & DirectoryIteration).entries
  if (typeof iterate !== 'function') return listing

  for await (const [name, handle] of iterate.call(dir)) {
    if (isHidden(name)) continue
    if (handle.kind === 'directory') {
      listing.directories.set(name, handle as FileSystemDirectoryHandle)
    } else {
      listing.files.set(name, handle as FileSystemFileHandle)
    }
  }

  return listing
}

/** Every subdirectory of the library root is a series. */
export async function listSeries(
  root: FileSystemDirectoryHandle,
): Promise<SeriesEntry[]> {
  const { directories } = await listDirectory(root)
  return [...directories.entries()]
    .map(([name, handle]) => ({ name, handle }))
    .sort((a, b) => naturalCompare(a.name, b.name))
}

export async function findSeries(
  root: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await root.getDirectoryHandle(name)
  } catch {
    return null
  }
}

/**
 * Chapters of a series, oldest first.
 *
 * Archives and image folders are listed together and sorted as one list, since
 * a library part-way through a conversion holds both.
 */
export async function listChapterEntries(
  series: FileSystemDirectoryHandle,
): Promise<ChapterEntry[]> {
  const { files, directories } = await listDirectory(series)
  const chapters: ChapterEntry[] = []

  for (const [name, handle] of files) {
    const supported = isArchiveName(name)
    if (!supported && !isUnsupportedArchiveName(name)) continue
    chapters.push({
      entryName: name,
      name: stripExtension(name),
      kind: supported ? 'archive' : 'unsupported',
      handle,
    })
  }

  for (const [name, handle] of directories) {
    chapters.push({ entryName: name, name, kind: 'directory', handle })
  }

  return chapters.sort((a, b) => naturalCompare(a.name, b.name))
}

/**
 * A chapter number for sorting and for the "mark previous as read" ordering.
 *
 * The app sorts chapters by this number, so a name it cannot read still has to
 * produce something ordered: `position` is the chapter's place in the natural
 * sort, which is the order the folder itself implies.
 */
export function recognizeChapterNumber(name: string, position: number): number {
  const cleaned = stripExtension(name)

  const labelled = /(?:^|[^a-z0-9])(?:ch|chapter|ep|episode)[\s._-]*([0-9]+(?:\.[0-9]+)?)/i.exec(
    cleaned,
  )
  if (labelled) return Number.parseFloat(labelled[1])

  // Otherwise the last number in the name, which covers "One Piece 1045" and
  // "Vol. 3 - 021" alike.
  const numbers = cleaned.match(/[0-9]+(?:\.[0-9]+)?/g)
  if (numbers && numbers.length > 0) {
    return Number.parseFloat(numbers[numbers.length - 1])
  }

  return position
}

/** The `cover.*` image of a series, if it has one. */
export function findCoverFile(
  listing: DirectoryListing,
): FileSystemFileHandle | null {
  for (const [name, handle] of listing.files) {
    if (stripExtension(name).toLowerCase() === COVER_STEM && isImageName(name)) {
      return handle
    }
  }
  return null
}

/**
 * The deprecated JSON details file, when present and readable.
 *
 * Superseded by `ComicInfo.xml` and only consulted when a series has none —
 * see `comic-info.ts`, which also explains why the conversion Mihon performs
 * here is deliberately not replicated.
 *
 * `details.json` is the documented name but Mihon accepts any `.json` in the
 * series folder, and folders in the wild are named after the series, so any
 * one of them is read.
 *
 * A series is never failed over its metadata: anything missing, unparseable or
 * of the wrong type is simply dropped and the folder name stands in.
 */
export async function readDetails(
  listing: DirectoryListing,
): Promise<LocalDetails> {
  const handle = listing.files.get(DETAILS_FILE) ?? findJsonFile(listing)
  if (!handle) return {}

  try {
    const text = await (await handle.getFile()).text()
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return {}
    const raw = parsed as Record<string, unknown>

    return {
      title: stringOf(raw.title),
      author: stringOf(raw.author),
      artist: stringOf(raw.artist),
      description: stringOf(raw.description),
      genre: genreOf(raw.genre),
      status: statusOf(raw.status),
    }
  } catch {
    return {}
  }
}

function findJsonFile(listing: DirectoryListing): FileSystemFileHandle | null {
  for (const [name, handle] of listing.files) {
    if (extensionOf(name) === 'json') return handle
  }
  return null
}

export function stringOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

/** An array in Mihon's format, but a comma-separated string is common enough to accept. */
function genreOf(value: unknown): string[] | undefined {
  const parts = Array.isArray(value)
    ? value.map((item) => stringOf(item))
    : typeof value === 'string'
      ? value.split(',').map((item) => stringOf(item))
      : []

  const genres = parts.filter((item): item is string => Boolean(item))
  return genres.length > 0 ? genres : undefined
}

/**
 * Publication status, from either format.
 *
 * `details.json` carries Mihon's `SManga` ordinal as a *string* digit
 * (`"status": "2"`), which is what the documented example writes and what the
 * generators produce; a bare number is accepted because hand-written files
 * often drop the quotes. `ComicInfo.xml` carries the name instead ("On
 * hiatus"), spelled as Mihon's `ComicInfoPublishingStatus` writes it, so both
 * spellings are read here.
 */
export function statusOf(value: unknown): MangaStatus | undefined {
  const byOrdinal: Record<number, MangaStatus> = {
    0: 'unknown',
    1: 'ongoing',
    2: 'completed',
    3: 'licensed',
    4: 'publishing_finished',
    5: 'cancelled',
    6: 'on_hiatus',
  }

  if (typeof value === 'number') return byOrdinal[value]

  const text = stringOf(value)
  if (!text) return undefined

  const numeric = Number.parseInt(text, 10)
  if (String(numeric) === text) return byOrdinal[numeric]

  switch (text.toLowerCase().replace(/[\s-]+/g, '_')) {
    case 'unknown':
      return 'unknown'
    case 'ongoing':
      return 'ongoing'
    case 'completed':
    case 'finished':
      return 'completed'
    case 'licensed':
      return 'licensed'
    case 'publishing_finished':
      return 'publishing_finished'
    case 'cancelled':
    case 'canceled':
    case 'dropped':
      return 'cancelled'
    case 'on_hiatus':
    case 'hiatus':
      return 'on_hiatus'
    default:
      return undefined
  }
}
