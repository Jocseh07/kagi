/**
 * App storage for imported local files, seen through the small part of the
 * File System Access API the shared local sources use.
 *
 * Imported comics live under `<documents>/local/comics` and books under
 * `<documents>/local/novels`. Anything derived from them (extracted pages,
 * covers) lives under `<cache>/local`, which the OS may purge and which is
 * rebuilt on demand.
 *
 * File names are kept as the user had them. Every URI is built from
 * `encodeURIComponent(name)` and every listed name is decoded back, so names
 * with spaces, `#` or `%` survive the trip through native URL parsing.
 */

import { Directory, File, Paths } from 'expo-file-system'

/** A file the user picked, already copied somewhere this app can read. */
export interface PickedFile {
  uri: string
  /** The name the user's copy had, extension included. */
  name: string
  lastModified?: number
}

export function localDocumentsRoot(): Directory {
  return new Directory(Paths.document, 'local')
}

export function comicsRoot(): Directory {
  return new Directory(localDocumentsRoot(), 'comics')
}

export function novelsRoot(): Directory {
  return new Directory(localDocumentsRoot(), 'novels')
}

export function localCacheRoot(): Directory {
  return new Directory(Paths.cache, 'local')
}

export function ensureDirectory(directory: Directory): Directory {
  if (!directory.exists) directory.create({ intermediates: true, idempotent: true })
  return directory
}

export function childFile(directory: Directory, name: string): File {
  return new File(directory, encodeURIComponent(name))
}

export function childDirectory(directory: Directory, name: string): Directory {
  return new Directory(directory, encodeURIComponent(name))
}

/** The on-disk name of a listed entry, decoded from its URI. */
export function entryName(entry: File | Directory): string {
  const uri = entry.uri.replace(/\/+$/, '')
  const raw = uri.slice(uri.lastIndexOf('/') + 1)
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export function listEntries(directory: Directory): (File | Directory)[] {
  if (!directory.exists) return []
  try {
    return directory.list()
  } catch {
    return []
  }
}

export function deleteIfExists(entry: File | Directory): void {
  try {
    if (entry.exists) entry.delete()
  } catch {
    // Already gone, or held open by the OS; the next sweep finds it again.
  }
}

/** Writes bytes to a file, replacing whatever was there. */
export function writeBytes(file: File, bytes: Uint8Array): void {
  ensureDirectory(file.parentDirectory)
  if (file.exists) file.delete()
  file.create()
  file.write(bytes)
}

// ------------------------------------------------------------ web shapes --

interface LocalWebFile {
  readonly uri: string
}

/**
 * An expo `File` in the shape of a web `File`.
 *
 * The shared sources only read `name`, `size`, `lastModified` and `text()`,
 * and hand the object back to the native seams, which find the file again
 * through `uri`. `lastModified` can be overridden for books, whose import
 * records keep the date the user's own copy had.
 */
export function asWebFile(
  file: File,
  name: string,
  lastModified: number = file.lastModified ?? 0,
): globalThis.File {
  const shaped = {
    uri: file.uri,
    name,
    size: file.size,
    type: file.type,
    lastModified,
    webkitRelativePath: '',
    text: () => file.text(),
    arrayBuffer: () => file.arrayBuffer(),
    bytes: () => file.bytes(),
    slice: (start?: number, end?: number, contentType?: string) =>
      file.slice(start, end, contentType),
    stream: () => file.stream(),
  }
  return shaped as unknown as globalThis.File
}

export function fileAt(uri: string): File {
  return new File(uri)
}

/** The app-storage file behind a blob handed out by these seams. */
export function localFileOf(blob: Blob): File {
  if (blob instanceof File) return blob
  const uri = (blob as Partial<LocalWebFile>).uri
  if (typeof uri !== 'string') {
    throw new Error('This file is not in app storage.')
  }
  return new File(uri)
}

// ---------------------------------------------------------------- handles --

function notFound(name: string): Error {
  const error = new Error(`"${name}" was not found.`)
  error.name = 'NotFoundError'
  return error
}

class NativeFileHandle {
  readonly kind = 'file' as const
  readonly name: string
  private readonly file: File

  constructor(file: File, name: string) {
    this.file = file
    this.name = name
  }

  async getFile(): Promise<globalThis.File> {
    return asWebFile(this.file, this.name)
  }
}

class NativeDirectoryHandle {
  readonly kind = 'directory' as const
  readonly name: string
  private readonly directory: Directory

  constructor(directory: Directory, name: string) {
    this.directory = directory
    this.name = name
  }

  async *entries(): AsyncIterableIterator<[string, FileSystemHandle]> {
    for (const entry of listEntries(this.directory)) {
      const name = entryName(entry)
      const handle =
        entry instanceof Directory
          ? new NativeDirectoryHandle(entry, name)
          : new NativeFileHandle(entry, name)
      yield [name, handle as unknown as FileSystemHandle]
    }
  }

  async getDirectoryHandle(name: string): Promise<FileSystemDirectoryHandle> {
    const directory = childDirectory(this.directory, name)
    if (!directory.exists) throw notFound(name)
    return wrapDirectory(directory, name)
  }

  async getFileHandle(name: string): Promise<FileSystemFileHandle> {
    const file = childFile(this.directory, name)
    if (!file.exists) throw notFound(name)
    return new NativeFileHandle(file, name) as unknown as FileSystemFileHandle
  }
}

function wrapDirectory(directory: Directory, name: string): FileSystemDirectoryHandle {
  return new NativeDirectoryHandle(directory, name) as unknown as FileSystemDirectoryHandle
}

/** A directory in app storage, as the handle the shared scanners walk. */
export function directoryHandle(directory: Directory): FileSystemDirectoryHandle {
  return wrapDirectory(directory, entryName(directory))
}

// ------------------------------------------------------------------ keys --

/** A short, stable, filesystem-safe key (cyrb53), for cache paths. */
export function hashKey(value: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** Identity of a file's current contents, so a replaced file misses its old cache. */
export function contentKey(file: File): string {
  return `${file.uri}|${file.size}|${file.lastModified ?? 0}`
}

/** Lets the UI draw between chunks of synchronous file work. */
export function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
