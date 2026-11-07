/**
 * The local comic library on native: comics imported into app storage.
 *
 * There is no folder picker on a phone that a source could keep reading from,
 * so files are copied into `<documents>/local/comics`, laid out exactly as the
 * web's chosen folder is (`<Series>/<Chapter>.cbz` or `<Series>/<Chapter>/`),
 * and the shared scanner reads that folder through `native-files` handles.
 * Series and chapter identities are therefore the same names the web uses.
 */

import {
  childDirectory,
  childFile,
  comicsRoot,
  deleteIfExists,
  directoryHandle,
  ensureDirectory,
  fileAt,
  listEntries,
  writeBytes,
  yieldToUi,
} from '@/lib/storage/native-files'
import type { PickedFile } from '@/lib/storage/native-files'
import { isJunkPath, withZip } from '@/lib/storage/zip'
import type { ZipArchive, ZipEntry } from '@/lib/storage/zip'
import { Directory } from 'expo-file-system'

import { clearLocalBlobUrls } from './blob-urls'
import { COMIC_INFO_FILE, NO_XML_FILE, parseComicInfo } from './comic-info'
import { clearLocalMetadata } from './metadata'
import { clearComicCaches, seriesPageCache } from './pages'
import { extensionOf, isArchiveName, isImageName, stripExtension } from './scan'

export const LOCAL_LIBRARY_KEY = 'local-library'

export type LocalLibraryStatus =
  /** Kept for parity with the web; app storage is always available here. */
  | 'unsupported'
  /** Nothing imported yet. */
  | 'unset'
  /** Kept for parity with the web; app storage needs no permission. */
  | 'denied'
  | 'ready'

export interface LocalLibraryState {
  status: LocalLibraryStatus
  /** The web's chosen folder name; imported comics have none. */
  folderName: string | null
}

const UNTITLED_SERIES = 'Untitled series'

let state: LocalLibraryState = { status: 'unset', folderName: null }
let loaded: Promise<LocalLibraryState> | undefined

const listeners = new Set<() => void>()

export function supportsLocalLibrary(): boolean {
  return true
}

/** Stable snapshot, safe to hand to `useSyncExternalStore`. */
export function getLocalLibraryState(): LocalLibraryState {
  return state
}

export function subscribeLocalLibrary(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function readState(): LocalLibraryState {
  const hasSeries = listEntries(comicsRoot()).some((entry) => entry instanceof Directory)
  return { status: hasSeries ? 'ready' : 'unset', folderName: null }
}

function publish(): LocalLibraryState {
  const next = readState()
  if (next.status !== state.status) {
    state = next
    for (const listener of listeners) listener()
  }
  loaded = Promise.resolve(state)
  return state
}

export function loadLocalLibrary(): Promise<LocalLibraryState> {
  loaded ??= Promise.resolve().then(publish)
  return loaded
}

/** Re-reads app storage; there is no permission to ask for again. */
export async function reconnectLocalLibrary(): Promise<LocalLibraryState> {
  clearCaches()
  return publish()
}

/** Opens the file picker and imports what the user chooses. */
export async function chooseLocalLibrary(): Promise<LocalLibraryState> {
  const { importLocalFiles } = await import('~/lib/local-import')
  await importLocalFiles('comic')
  return state
}

/** Deletes every imported comic and everything extracted from them. */
export async function forgetLocalLibrary(): Promise<LocalLibraryState> {
  deleteIfExists(comicsRoot())
  clearComicCaches()
  clearCaches()
  return publish()
}

/** Deletes one imported series and its extracted pages. */
export async function deleteLocalSeries(name: string): Promise<LocalLibraryState> {
  deleteIfExists(childDirectory(comicsRoot(), name))
  deleteIfExists(seriesPageCache(name))
  clearCaches()
  return publish()
}

export async function getLibraryRoot(): Promise<FileSystemDirectoryHandle | null> {
  return directoryHandle(ensureDirectory(comicsRoot()))
}

export async function requireLibraryRoot(): Promise<FileSystemDirectoryHandle> {
  return directoryHandle(ensureDirectory(comicsRoot()))
}

const timestamps = new Map<string, number>()

export function getCachedTimestamp(seriesName: string): number | undefined {
  return timestamps.get(seriesName)
}

export function cacheTimestamp(seriesName: string, value: number): void {
  timestamps.set(seriesName, value)
}

function clearCaches(): void {
  timestamps.clear()
  clearLocalMetadata()
  clearLocalBlobUrls()
}

// ------------------------------------------------------------------ import --

/**
 * Copies picked files into the library, one series per group of files.
 *
 * A CBZ/ZIP is one chapter. Its series is the `<Series>` of its root
 * `ComicInfo.xml` when it has one, otherwise its file name less the chapter
 * or volume part ("One Piece - Chapter 1045.cbz" goes to "One Piece"), so
 * chapters picked together land in one series and later imports add to it.
 * A chapter already in that series under the same name is replaced: the
 * library already knows it by that name.
 *
 * A `.zip` holding chapter archives or several folders of images is a whole
 * series (or library) packed for the trip, since a phone cannot pick a
 * folder; it is unpacked into the same layout.
 *
 * Files are copied, never moved: the picker's copies are the caller's to
 * clean up. RAR, 7z, TAR and EPUB chapters cannot be read here, so they are
 * rejected rather than stored.
 */
export async function importComics(
  files: readonly PickedFile[],
): Promise<{ imported: number; rejected: string[] }> {
  const root = ensureDirectory(comicsRoot())
  const rejected: string[] = []
  const touched = new Set<string>()
  let imported = 0
  let untitled: string | undefined

  const untitledSeries = () => (untitled ??= freeSeriesName(root, UNTITLED_SERIES))

  for (const picked of files) {
    if (!isArchiveName(picked.name)) {
      rejected.push(picked.name)
      continue
    }

    try {
      const source = fileAt(picked.uri)
      const count = await withZip(source, async (zip) => {
        const bundle =
          extensionOf(picked.name) === 'zip'
            ? bundlePlacements(zip.entries, seriesNameFromFile(picked.name) ?? untitledSeries())
            : null
        if (bundle) return await unpackBundle(zip, root, bundle, touched)

        const series = sanitizeName(
          comicInfoSeries(zip) ?? seriesNameFromFile(picked.name) ?? untitledSeries(),
        )
        const seriesDirectory = ensureDirectory(childDirectory(root, series))
        await source.copy(childFile(seriesDirectory, picked.name), { overwrite: true })
        touched.add(series)
        return 1
      })
      if (count === 0) rejected.push(picked.name)
      imported += count
    } catch {
      rejected.push(picked.name)
    }
    await yieldToUi()
  }

  // A replaced chapter must not be read from pages extracted from the old one.
  for (const series of touched) deleteIfExists(seriesPageCache(series))
  clearCaches()
  publish()

  return { imported, rejected }
}

function comicInfoSeries(zip: ZipArchive): string | undefined {
  const entry = zip.find(COMIC_INFO_FILE, true)
  if (!entry) return undefined
  try {
    return parseComicInfo(zip.readText(entry))?.series.title
  } catch {
    return undefined
  }
}

/**
 * A series name from a chapter's file name, or null when nothing is left.
 *
 * Scanlator tags in brackets go first, then everything from the first
 * chapter or volume marker, and failing one, a trailing number: the same
 * markers `recognizeChapterNumber` reads the chapter number from.
 */
export function seriesNameFromFile(fileName: string): string | null {
  const cleaned = stripExtension(fileName)
    .replace(/_/g, ' ')
    .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const marker = /(?:^|[\s.-])(?:vol(?:ume)?|ch(?:apter)?|ep(?:isode)?|v(?=\d)|c(?=\d)|#)[\s.]*\d/i.exec(
    cleaned,
  )
  const head = marker
    ? cleaned.slice(0, marker.index)
    : cleaned.replace(/[\s.-]*\d+(?:\.\d+)?$/, '')

  const name = head.replace(/[\s.-]+$/, '').trim()
  return name && /[^\d\s.-]/.test(name) ? name : null
}

/** Safe as a single folder name; never empty, never hidden. */
function sanitizeName(name: string): string {
  const safe = name.replace(/[\\/]/g, '-').replace(/^\.+/, '').trim()
  return safe || UNTITLED_SERIES
}

/** `Untitled series` → `Untitled series (2)`, until no series has the name. */
function freeSeriesName(root: Directory, name: string): string {
  if (!childDirectory(root, name).exists) return name
  for (let n = 2; ; n += 1) {
    const candidate = `${name} (${n})`
    if (!childDirectory(root, candidate).exists) return candidate
  }
}

// ----------------------------------------------------------------- bundles --

interface Placement {
  entry: ZipEntry
  /** Path under the library root: series, then chapter file or folder, then file. */
  path: string[]
}

interface BundleFile {
  entry: ZipEntry
  dirs: string[]
  base: string
}

function isCoverName(name: string): boolean {
  return stripExtension(name).toLowerCase() === 'cover' && isImageName(name)
}

function isAttachmentName(name: string): boolean {
  return (
    isCoverName(name) ||
    name.toLowerCase() === COMIC_INFO_FILE.toLowerCase() ||
    name === NO_XML_FILE ||
    extensionOf(name) === 'json'
  )
}

/**
 * Where each entry of a packed series goes, or null when the archive is just
 * a chapter (one folder of images, or images at its root).
 *
 *   <Series>/<Chapter>.cbz        chapter archive
 *   <Series>/<Chapter>/001.jpg    chapter folder
 *   <Chapter>/001.jpg             chapter folder of the archive's own series
 *   <Chapter>.cbz                 chapter archive of the archive's own series
 *
 * Covers and metadata files follow the folder they sat in.
 */
function bundlePlacements(entries: ZipEntry[], fallback: string): Placement[] | null {
  const files: BundleFile[] = []
  for (const entry of entries) {
    if (entry.directory) continue
    const segments = entry.name.split('/').filter(Boolean)
    const base = segments.pop()
    if (!base) continue
    const hidden = base.startsWith('.') && base !== NO_XML_FILE
    if (hidden || isJunkPath(segments.join('/'))) continue
    files.push({ entry, dirs: segments, base })
  }

  const hasChapterArchives = files.some((file) => isArchiveName(file.base))
  const imageFolders = new Set(
    files
      .filter((file) => isImageName(file.base) && !isCoverName(file.base) && file.dirs.length > 0)
      .map((file) => file.dirs.join('/')),
  )
  if (!hasChapterArchives && imageFolders.size < 2) return null

  const placements: Placement[] = []
  const series = new Set<string>()
  const chapterFolders = new Set<string>()

  for (const file of files) {
    if (isAttachmentName(file.base)) continue
    const { dirs, base, entry } = file

    if (isArchiveName(base)) {
      const name = dirs.at(-1) ?? fallback
      series.add(name)
      placements.push({ entry, path: [name, base] })
    } else if (isImageName(base) && dirs.length > 0) {
      const name = dirs.length >= 2 ? dirs[dirs.length - 2] : fallback
      const chapter = dirs[dirs.length - 1]
      series.add(name)
      chapterFolders.add(`${name}/${chapter}`)
      placements.push({ entry, path: [name, chapter, base] })
    }
  }

  for (const { dirs, base, entry } of files) {
    if (!isAttachmentName(base)) continue
    const parent = dirs.at(-1)
    const grandparent = dirs.length >= 2 ? dirs[dirs.length - 2] : fallback

    if (parent && chapterFolders.has(`${grandparent}/${parent}`)) {
      placements.push({ entry, path: [grandparent, parent, base] })
    } else if (parent && series.has(parent)) {
      placements.push({ entry, path: [parent, base] })
    } else if (!parent && series.has(fallback)) {
      placements.push({ entry, path: [fallback, base] })
    }
  }

  return placements
}

async function unpackBundle(
  zip: ZipArchive,
  root: Directory,
  placements: Placement[],
  touched: Set<string>,
): Promise<number> {
  const chapters = new Set<string>()

  for (const { entry, path } of placements) {
    const [seriesName, ...rest] = path
    const seriesKey = sanitizeName(seriesName)
    let directory = childDirectory(root, seriesKey)
    for (const segment of rest.slice(0, -1)) {
      directory = childDirectory(directory, sanitizeName(segment))
    }
    writeBytes(childFile(directory, rest[rest.length - 1]), zip.read(entry))

    touched.add(seriesKey)
    if (rest.length === 1 && isArchiveName(rest[0])) chapters.add(`${seriesKey}/${rest[0]}`)
    if (rest.length === 2) chapters.add(`${seriesKey}/${rest[0]}`)
    await yieldToUi()
  }

  return chapters.size
}
