/**
 * Reads a Mihon backup file (`.tachibk`) into plain objects.
 *
 * The file is a gzipped protobuf message whose field numbers come from
 * `@ProtoNumber` annotations in Mihon's `data/backup/models`. They are
 * transcribed below and were checked against a real 64-series export, so the
 * comments name the Kotlin property each number belongs to — that is the only
 * documentation this format has.
 *
 * Nothing here knows about sources or the database. Mapping onto ours is
 * `mihon-mapping.ts`; writing is `mihon-import.ts`.
 */

import {
  decodeMessage,
  readBool,
  readFloat,
  readInt,
  readLong,
  readMessages,
  readPackedInts,
  readString,
  readStrings,
} from './protobuf'
import type { Message } from './protobuf'

export interface MihonBackup {
  manga: MihonManga[]
  categories: MihonCategory[]
  /** Declared sources, by 64-bit id. The only place their names appear. */
  sources: MihonSource[]
}

export interface MihonSource {
  id: bigint
  name: string
}

export interface MihonCategory {
  name: string
  order: number
}

export interface MihonManga {
  sourceId: bigint
  url: string
  title: string
  artist?: string
  author?: string
  description?: string
  genres: string[]
  /** Mihon's `SManga` status constant. See `MIHON_STATUS` in the mapping. */
  status: number
  thumbnailUrl?: string
  dateAdded: number
  /**
   * Whether the series is in the library. A backup also carries series that
   * were removed from it but still hold read progress, and those arrive here
   * as `false`.
   */
  favorite: boolean
  /** Indexes into `MihonBackup.categories`, in that list's own order. */
  categoryOrders: number[]
  chapters: MihonChapter[]
  history: MihonHistory[]
}

export interface MihonChapter {
  url: string
  name: string
  scanlator?: string
  read: boolean
  bookmark: boolean
  lastPageRead: number
  dateUpload: number
  /** `-1` where Mihon could not parse one, matching our column default. */
  chapterNumber: number
}

export interface MihonHistory {
  /** The chapter's url, which is how a history row names its chapter. */
  chapterUrl: string
  lastRead: number
}

/** `1f 8b`, the gzip magic. A `.tachibk` always carries it; a decoded one does not. */
const GZIP_MAGIC = [0x1f, 0x8b]

export class BackupFormatError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'BackupFormatError'
  }
}

/**
 * Decompresses when the bytes are gzipped, and passes them through when they
 * are not — the same file turns up already decompressed often enough (a
 * download that unwrapped it, a fixture) that failing on it would be unhelpful.
 */
export async function decompressBackup(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes[0] !== GZIP_MAGIC[0] || bytes[1] !== GZIP_MAGIC[1]) return bytes

  if (typeof DecompressionStream === 'undefined') {
    throw new BackupFormatError(
      'This browser cannot decompress gzip. Try a recent Chrome, Firefox or Safari.',
    )
  }

  try {
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch (cause) {
    throw new BackupFormatError('The file is not a readable gzip archive.', {
      cause,
    })
  }
}

export async function parseMihonBackup(bytes: Uint8Array): Promise<MihonBackup> {
  const decompressed = await decompressBackup(bytes)

  let root: Message
  try {
    root = decodeMessage(decompressed)
  } catch (cause) {
    throw new BackupFormatError(
      'This does not look like a Mihon backup. Pick the .tachibk file Mihon wrote.',
      { cause },
    )
  }

  // Backup: 1 backupManga, 2 backupCategories, 101 backupSources.
  const backup: MihonBackup = {
    manga: readMessages(root, 1).map(readManga),
    categories: readMessages(root, 2).map(readCategory),
    sources: readMessages(root, 101).map(readSource),
  }

  // A protobuf message has no header, so any blob decodes into *something*.
  // A backup with neither series nor sources is that something, not a backup.
  if (backup.manga.length === 0 && backup.sources.length === 0) {
    throw new BackupFormatError(
      'This does not look like a Mihon backup. Pick the .tachibk file Mihon wrote.',
    )
  }

  return backup
}

/** BackupSource: 1 name, 2 sourceId. */
function readSource(message: Message): MihonSource {
  return {
    name: readString(message, 1) ?? '',
    id: readLong(message, 2) ?? 0n,
  }
}

/** BackupCategory: 1 name, 2 order. */
function readCategory(message: Message): MihonCategory {
  return {
    name: readString(message, 1) ?? '',
    order: readInt(message, 2) ?? 0,
  }
}

/**
 * BackupManga: 1 source, 2 url, 3 title, 4 artist, 5 author, 6 description,
 * 7 genre, 8 status, 9 thumbnailUrl, 13 dateAdded, 16 chapters, 17 categories,
 * 100 favorite, 104 history.
 *
 * `favorite` defaults to true in Kotlin, so an absent field — which is what the
 * encoder writes for `true` — must read as true here too.
 */
function readManga(message: Message): MihonManga {
  return {
    sourceId: readLong(message, 1) ?? 0n,
    url: readString(message, 2) ?? '',
    title: readString(message, 3) ?? '',
    artist: readString(message, 4),
    author: readString(message, 5),
    description: readString(message, 6),
    genres: readStrings(message, 7),
    status: readInt(message, 8) ?? 0,
    thumbnailUrl: readString(message, 9),
    dateAdded: readInt(message, 13) ?? 0,
    chapters: readMessages(message, 16).map(readChapter),
    categoryOrders: readPackedInts(message, 17),
    favorite: readBool(message, 100) ?? true,
    history: readMessages(message, 104).map(readHistory),
  }
}

/**
 * BackupChapter: 1 url, 2 name, 3 scanlator, 4 read, 5 bookmark,
 * 6 lastPageRead, 8 dateUpload, 9 chapterNumber.
 */
function readChapter(message: Message): MihonChapter {
  return {
    url: readString(message, 1) ?? '',
    name: readString(message, 2) ?? '',
    scanlator: readString(message, 3),
    read: readBool(message, 4) ?? false,
    bookmark: readBool(message, 5) ?? false,
    lastPageRead: readInt(message, 6) ?? 0,
    dateUpload: readInt(message, 8) ?? 0,
    chapterNumber: readFloat(message, 9) ?? -1,
  }
}

/** BackupHistory: 1 url, 2 lastRead. */
function readHistory(message: Message): MihonHistory {
  return {
    chapterUrl: readString(message, 1) ?? '',
    lastRead: readInt(message, 2) ?? 0,
  }
}
