/**
 * Turning a chapter in app storage into a page list, on native.
 *
 * A folder chapter's images are already files, so their URIs are the pages.
 * A CBZ/ZIP chapter is unpacked once into the cache, one file per page, and
 * read from there afterwards: the cache folder is keyed by the archive's size
 * and date, so replacing a chapter misses the old copy instead of showing it.
 */

import { strToU8 } from 'fflate'

import {
  childDirectory,
  contentKey,
  deleteIfExists,
  ensureDirectory,
  entryName,
  hashKey,
  localCacheRoot,
  localFileOf,
  writeBytes,
  yieldToUi,
} from '@/lib/storage/native-files'
import { isJunkPath, withZip } from '@/lib/storage/zip'
import type { ZipArchive, ZipEntry } from '@/lib/storage/zip'
import { Directory, File } from 'expo-file-system'

import type { Page } from '../types'
import { extensionOf, isImageName, listDirectory, naturalCompare } from './scan'
import type { ChapterKind } from './scan'

const MANIFEST = 'pages.json'

function pagesCacheRoot(): Directory {
  return new Directory(localCacheRoot(), 'pages')
}

/** Every page extracted for one series, so removing the series removes them. */
export function seriesPageCache(seriesName: string): Directory {
  return childDirectory(pagesCacheRoot(), hashKey(seriesName))
}

function coverCacheRoot(): Directory {
  return new Directory(localCacheRoot(), 'covers')
}

/**
 * Writes one archive entry into a cache folder, reusing an earlier copy.
 *
 * The extension is kept for the image decoder, and the name is keyed by
 * `key` so a replaced archive misses the old copy.
 */
export function extractCover(
  zip: ZipArchive,
  entry: ZipEntry,
  key: string,
  directory: Directory = coverCacheRoot(),
): File {
  const extension = extensionOf(entry.name)
  const target = new File(directory, `${hashKey(key)}${extension ? `.${extension}` : ''}`)
  if (!target.exists) writeBytes(target, zip.read(entry))
  return target
}

function imageEntries(zip: ZipArchive): ZipEntry[] {
  return zip.entries
    .filter((entry) => !entry.directory && !isJunkPath(entry.name) && isImageName(entry.name))
    .sort((a, b) => naturalCompare(a.name, b.name))
}

function readManifest(directory: Directory): string[] | null {
  const manifest = new File(directory, MANIFEST)
  if (!manifest.exists) return null
  try {
    const names: unknown = JSON.parse(manifest.textSync())
    if (!Array.isArray(names) || !names.every((name) => typeof name === 'string')) return null
    // The OS may purge part of the cache; a gap means unpacking again.
    return names.every((name) => new File(directory, name).exists) ? names : null
  } catch {
    return null
  }
}

function toPages(directory: Directory, names: string[]): Page[] {
  return names.map((name, index) => ({ index, imageUrl: new File(directory, name).uri }))
}

export async function readArchivePages(
  handle: FileSystemFileHandle,
  keyPrefix: string,
): Promise<Page[]> {
  const file = localFileOf(await handle.getFile())
  const seriesName = keyPrefix.slice(0, keyPrefix.indexOf('/'))
  const directory = childDirectory(seriesPageCache(seriesName), hashKey(contentKey(file)))

  const cached = readManifest(directory)
  if (cached) return toPages(directory, cached)

  deleteIfExists(directory)
  ensureDirectory(directory)

  const names = await withZip(file, async (zip) => {
    const written: string[] = []
    for (const [index, entry] of imageEntries(zip).entries()) {
      const name = `${index}.${extensionOf(entry.name)}`
      writeBytes(new File(directory, name), zip.read(entry))
      written.push(name)
      await yieldToUi()
    }
    return written
  })

  writeBytes(new File(directory, MANIFEST), strToU8(JSON.stringify(names)))
  return toPages(directory, names)
}

export async function readDirectoryPages(
  handle: FileSystemDirectoryHandle,
  _keyPrefix: string,
): Promise<Page[]> {
  const { files } = await listDirectory(handle)
  const names = [...files.keys()].filter(isImageName).sort((a, b) => naturalCompare(a, b))

  const pages: Page[] = []
  for (const [index, name] of names.entries()) {
    const file = localFileOf(await files.get(name)!.getFile())
    pages.push({ index, imageUrl: file.uri })
  }
  return pages
}

/** First image of a chapter, for series with no `cover.*` of their own. */
export async function readFirstImage(
  handle: FileSystemFileHandle | FileSystemDirectoryHandle,
  kind: ChapterKind,
): Promise<Blob | null> {
  if (kind === 'unsupported') return null

  try {
    if (kind === 'archive') {
      const file = localFileOf(await (handle as FileSystemFileHandle).getFile())
      return await withZip(file, (zip) => {
        const first = imageEntries(zip)[0]
        if (!first) return null
        // Kept with the series' pages, so removing the series removes its cover.
        const covers = new Directory(seriesPageCache(entryName(file.parentDirectory)), 'covers')
        return extractCover(zip, first, `first-page|${contentKey(file)}`, covers)
      })
    }

    const { files } = await listDirectory(handle as FileSystemDirectoryHandle)
    const first = [...files.keys()].filter(isImageName).sort((a, b) => naturalCompare(a, b))[0]
    return first ? await files.get(first)!.getFile() : null
  } catch {
    return null
  }
}

/** Every page and cover extracted from imported comics. */
export function clearComicCaches(): void {
  deleteIfExists(pagesCacheRoot())
}
