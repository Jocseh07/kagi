/**
 * Minimal EPUB reader.
 *
 * An EPUB is a zip holding XHTML documents plus a package file describing their
 * order. Only what a reader needs is parsed: the spine (which documents, in
 * what order), the manifest (how to resolve them, and which is the cover) and a
 * handful of Dublin Core metadata fields.
 *
 * EPUB 2 and 3 differ in where the cover is declared and in whether the spine
 * carries a table of contents, so both forms are probed. Anything else in the
 * specification — encryption, media overlays, fixed layout — is ignored: those
 * describe presentation this reader does not offer.
 */

import type { FileEntry } from '@zip.js/zip.js'

import { loadZip } from '../local/archive'
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

/**
 * Reads a book's structure without inflating its chapters.
 *
 * Only the container, the package document and (for EPUB 2) the NCX are
 * decompressed, so opening a 5 MB novel to list its chapters stays cheap.
 */
export async function readEpubStructure(file: File): Promise<EpubBook> {
  const { BlobReader, TextWriter, ZipReader } = await loadZip()
  const reader = new ZipReader(new BlobReader(file))

  try {
    const entries = await reader.getEntries()
    const byPath = new Map(
      entries
        .filter((entry): entry is FileEntry => !entry.directory)
        .map((entry) => [normalise(entry.filename), entry]),
    )

    const readText = async (path: string): Promise<string | null> => {
      const entry = byPath.get(normalise(path))
      if (!entry) return null
      return await entry.getData(new TextWriter())
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
  } finally {
    await reader.close().catch(() => undefined)
  }
}

/** Reads one chapter's document and returns it as sanitised prose. */
export async function readEpubChapter(
  file: File,
  href: string,
): Promise<ChapterText> {
  const { BlobReader, TextWriter, ZipReader } = await loadZip()
  const reader = new ZipReader(new BlobReader(file))

  try {
    const wanted = normalise(href)
    const entry = (await reader.getEntries()).find(
      (candidate): candidate is FileEntry =>
        !candidate.directory && normalise(candidate.filename) === wanted,
    )
    if (!entry) {
      throw new Error(`"${href}" is not in this EPUB.`)
    }

    const xml = await entry.getData(new TextWriter())
    return sanitizeChapterHtml(bodyOf(xml))
  } finally {
    await reader.close().catch(() => undefined)
  }
}

/** Extracts the cover image, for the shelf thumbnail. */
export async function readEpubCover(
  file: File,
  href: string,
): Promise<Blob | null> {
  const { BlobReader, BlobWriter, ZipReader } = await loadZip()
  const reader = new ZipReader(new BlobReader(file))

  try {
    const wanted = normalise(href)
    const entry = (await reader.getEntries()).find(
      (candidate): candidate is FileEntry =>
        !candidate.directory && normalise(candidate.filename) === wanted,
    )
    if (!entry) return null
    return await entry.getData(new BlobWriter())
  } catch {
    return null
  } finally {
    await reader.close().catch(() => undefined)
  }
}
