/**
 * Turning a chapter on disk into a page list.
 *
 * Both shapes Mihon supports are handled: a CBZ/ZIP archive, read with zip.js,
 * and a folder of loose images. Either way the pages come back as blob URLs
 * owned by `blob-urls.ts` — see the ownership rule documented there.
 */

import type { FileEntry } from '@zip.js/zip.js'

import type { Page } from '../types'
import { loadZip } from './archive'
import { pageUrls } from './blob-urls'
import {
  imageMimeType,
  isImageName,
  listDirectory,
  naturalCompare,
} from './scan'
import type { ChapterKind } from './scan'

/** `limit` exists so a cover costs one entry rather than a whole chapter. */
async function readArchiveImages(
  file: File,
  limit = Number.POSITIVE_INFINITY,
): Promise<{ filename: string; blob: Blob }[]> {
  const { BlobReader, BlobWriter, ZipReader } = await loadZip()
  const reader = new ZipReader(new BlobReader(file))

  try {
    const entries = (await reader.getEntries())
      .filter(
        (entry): entry is FileEntry =>
          !entry.directory && isImageName(entry.filename),
      )
      .sort((a, b) => naturalCompare(a.filename, b.filename))

    const images: { filename: string; blob: Blob }[] = []
    for (const entry of entries) {
      if (images.length >= limit) break
      const blob = await entry.getData(new BlobWriter(imageMimeType(entry.filename)))
      images.push({ filename: entry.filename, blob })
    }
    return images
  } finally {
    await reader.close().catch(() => undefined)
  }
}

export async function readArchivePages(
  handle: FileSystemFileHandle,
  keyPrefix: string,
): Promise<Page[]> {
  const images = await readArchiveImages(await handle.getFile())
  return images.map((image, index) => ({
    index,
    imageUrl: pageUrls.put(`${keyPrefix}#${index}`, image.blob),
  }))
}

export async function readDirectoryPages(
  handle: FileSystemDirectoryHandle,
  keyPrefix: string,
): Promise<Page[]> {
  const { files } = await listDirectory(handle)
  const names = [...files.keys()]
    .filter(isImageName)
    .sort((a, b) => naturalCompare(a, b))

  const pages: Page[] = []
  for (const [index, name] of names.entries()) {
    const file = await files.get(name)!.getFile()
    pages.push({
      index,
      imageUrl: pageUrls.put(`${keyPrefix}#${index}`, file),
    })
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
      const images = await readArchiveImages(
        await (handle as FileSystemFileHandle).getFile(),
        1,
      )
      return images[0]?.blob ?? null
    }

    const { files } = await listDirectory(handle as FileSystemDirectoryHandle)
    const first = [...files.keys()]
      .filter(isImageName)
      .sort((a, b) => naturalCompare(a, b))[0]
    return first ? await files.get(first)!.getFile() : null
  } catch {
    return null
  }
}
