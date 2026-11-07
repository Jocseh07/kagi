/**
 * Minimal EPUB reader on native: the shared package parser over the app's
 * own ZIP reader. Only the entries asked for are inflated.
 */

import { hashKey, localCacheRoot, localFileOf } from '@/lib/storage/native-files'
import { withZip } from '@/lib/storage/zip'
import type { ZipArchive, ZipEntry } from '@/lib/storage/zip'
import { Directory } from 'expo-file-system'

import { extractCover } from '../local/pages'
import { sanitizeChapterHtml } from '../../text/sanitize'
import type { ChapterText } from '../types'
import {
  CONTAINER_PATH,
  bodyOf,
  normalise,
  parsePackage,
  rootfilePath,
} from './epub-package'
import type { EpubBook } from './epub-package'

/** Images extracted from one book, so deleting the book can delete them. */
export function novelCacheDirectory(name: string): Directory {
  return new Directory(localCacheRoot(), 'novels', hashKey(name))
}

function entriesByPath(zip: ZipArchive): Map<string, ZipEntry> {
  return new Map(
    zip.entries
      .filter((entry) => !entry.directory)
      .map((entry) => [normalise(entry.name), entry]),
  )
}

/** Reads a book's structure without inflating its chapters. */
export async function readEpubStructure(file: File): Promise<EpubBook> {
  return withZip(localFileOf(file), async (zip) => {
    const byPath = entriesByPath(zip)

    const readText = async (path: string): Promise<string | null> => {
      const entry = byPath.get(normalise(path))
      return entry ? zip.readText(entry) : null
    }

    const container = await readText(CONTAINER_PATH)
    if (!container) throw new Error('Not an EPUB: no META-INF/container.xml.')

    const packagePath = rootfilePath(container)
    if (!packagePath) {
      throw new Error('This EPUB names no package document.')
    }

    const packageXml = await readText(packagePath)
    if (!packageXml) {
      throw new Error(`This EPUB's package file (${packagePath}) is missing.`)
    }

    return parsePackage(packageXml, packagePath, byPath, readText)
  })
}

/** Reads one chapter's document and returns it as sanitised prose. */
export async function readEpubChapter(
  file: File,
  href: string,
): Promise<ChapterText> {
  return withZip(localFileOf(file), (zip) => {
    const entry = entriesByPath(zip).get(normalise(href))
    if (!entry) {
      throw new Error(`"${href}" is not in this EPUB.`)
    }
    return sanitizeChapterHtml(bodyOf(zip.readText(entry)))
  })
}

/** Extracts the cover image into the cache, for the shelf thumbnail. */
export async function readEpubCover(
  file: File,
  href: string,
): Promise<Blob | null> {
  try {
    const local = localFileOf(file)
    return await withZip(local, (zip) => {
      const entry = entriesByPath(zip).get(normalise(href))
      return entry
        ? extractCover(
            zip,
            entry,
            `${local.size}|${local.lastModified ?? 0}|${href}`,
            novelCacheDirectory(file.name),
          )
        : null
    })
  } catch {
    return null
  }
}
