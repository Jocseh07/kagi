/**
 * Random-access ZIP reading over app storage, for CBZ chapters and EPUBs.
 *
 * Only the central directory is read up front, and each entry is read and
 * inflated on its own, so pulling a `ComicInfo.xml` or one cover out of a
 * 200 MB archive never loads the rest. Stored and deflated entries are
 * supported, ZIP64 included; anything else (encryption, bzip2, LZMA) fails
 * that one entry with a message rather than the whole archive.
 */

import { inflateSync, strFromU8 } from 'fflate'

import { File, FileMode } from 'expo-file-system'

export interface ZipEntry {
  /** Path inside the archive, with `/` separators. */
  name: string
  directory: boolean
  flags: number
  method: number
  compressedSize: number
  size: number
  localOffset: number
}

const EOCD = 0x06054b50
const ZIP64_LOCATOR = 0x07064b50
const ZIP64_EOCD = 0x06064b50
const CENTRAL_HEADER = 0x02014b50
const LOCAL_HEADER = 0x04034b50

const EOCD_LENGTH = 22
const MAX_COMMENT = 0xffff
const UTF8_FLAG = 0x800
const ENCRYPTED_FLAG = 0x1

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8)
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) + bytes[at + 3] * 0x1000000
}

function u64(bytes: Uint8Array, at: number): number {
  return u32(bytes, at) + u32(bytes, at + 4) * 0x100000000
}

function decodeName(bytes: Uint8Array, flags: number): string {
  // Most tools write UTF-8 without setting the flag, so UTF-8 is tried first
  // either way and the legacy code page is only the fallback.
  try {
    return strFromU8(bytes)
  } catch {
    return strFromU8(bytes, (flags & UTF8_FLAG) === 0)
  }
}

export class ZipArchive {
  readonly entries: ZipEntry[]
  private readonly handle: ReturnType<File['open']>
  private readonly size: number

  private constructor(file: File) {
    this.handle = file.open(FileMode.ReadOnly)
    this.size = this.handle.size ?? file.size
    try {
      this.entries = this.readCentralDirectory()
    } catch (error) {
      this.close()
      throw error
    }
  }

  static open(file: File): ZipArchive {
    if (!file.exists) throw new Error(`"${file.name}" is no longer on this device.`)
    return new ZipArchive(file)
  }

  close(): void {
    try {
      this.handle.close()
    } catch {
      // Closing twice is harmless.
    }
  }

  /** A file entry by path; `caseInsensitive` for names written on Windows. */
  find(path: string, caseInsensitive = false): ZipEntry | undefined {
    if (!caseInsensitive) {
      return this.entries.find((entry) => !entry.directory && entry.name === path)
    }
    const wanted = path.toLowerCase()
    return this.entries.find(
      (entry) => !entry.directory && entry.name.toLowerCase() === wanted,
    )
  }

  read(entry: ZipEntry): Uint8Array {
    if (entry.flags & ENCRYPTED_FLAG) {
      throw new Error(`"${entry.name}" is encrypted.`)
    }

    const header = this.readAt(entry.localOffset, 30)
    if (u32(header, 0) !== LOCAL_HEADER) {
      throw new Error(`"${entry.name}" is damaged in this archive.`)
    }
    const dataOffset = entry.localOffset + 30 + u16(header, 26) + u16(header, 28)
    const raw = this.readAt(dataOffset, entry.compressedSize)

    if (entry.method === 0) return raw
    if (entry.method === 8) {
      return entry.size > 0
        ? inflateSync(raw, { out: new Uint8Array(entry.size) })
        : inflateSync(raw)
    }
    throw new Error(`"${entry.name}" uses a compression this app cannot read.`)
  }

  readText(entry: ZipEntry): string {
    return strFromU8(this.read(entry)).replace(/^\uFEFF/, '')
  }

  private readAt(offset: number, length: number): Uint8Array {
    if (length === 0) return new Uint8Array(0)
    this.handle.offset = offset
    return this.handle.readBytes(length)
  }

  private readCentralDirectory(): ZipEntry[] {
    const tailLength = Math.min(this.size, EOCD_LENGTH + MAX_COMMENT)
    const tail = this.readAt(this.size - tailLength, tailLength)

    let eocd = -1
    for (let at = tail.length - EOCD_LENGTH; at >= 0; at--) {
      if (u32(tail, at) === EOCD) {
        eocd = at
        break
      }
    }
    if (eocd < 0) throw new Error('This file is not a ZIP archive.')

    let count = u16(tail, eocd + 10)
    let directorySize = u32(tail, eocd + 12)
    let directoryOffset = u32(tail, eocd + 16)

    const locator = eocd - 20
    if (
      (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) &&
      locator >= 0 &&
      u32(tail, locator) === ZIP64_LOCATOR
    ) {
      const record = this.readAt(u64(tail, locator + 8), 56)
      if (u32(record, 0) === ZIP64_EOCD) {
        count = u64(record, 32)
        directorySize = u64(record, 40)
        directoryOffset = u64(record, 48)
      }
    }

    const directory = this.readAt(directoryOffset, directorySize)
    const entries: ZipEntry[] = []
    let at = 0

    while (entries.length < count && at + 46 <= directory.length) {
      if (u32(directory, at) !== CENTRAL_HEADER) break

      const flags = u16(directory, at + 8)
      const method = u16(directory, at + 10)
      let compressedSize = u32(directory, at + 20)
      let size = u32(directory, at + 24)
      const nameLength = u16(directory, at + 28)
      const extraLength = u16(directory, at + 30)
      const commentLength = u16(directory, at + 32)
      let localOffset = u32(directory, at + 42)

      const nameStart = at + 46
      const name = decodeName(directory.subarray(nameStart, nameStart + nameLength), flags)
        .replace(/\\/g, '/')

      const extraStart = nameStart + nameLength
      const extraEnd = extraStart + extraLength
      for (let field = extraStart; field + 4 <= extraEnd; ) {
        const id = u16(directory, field)
        const length = u16(directory, field + 2)
        if (id === 0x0001) {
          let cursor = field + 4
          if (size === 0xffffffff) {
            size = u64(directory, cursor)
            cursor += 8
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = u64(directory, cursor)
            cursor += 8
          }
          if (localOffset === 0xffffffff) localOffset = u64(directory, cursor)
        }
        field += 4 + length
      }

      entries.push({
        name,
        directory: name.endsWith('/'),
        flags,
        method,
        compressedSize,
        size,
        localOffset,
      })
      at = extraEnd + commentLength
    }

    return entries
  }
}

/** Opens an archive for the length of `task`, closing it however `task` ends. */
export async function withZip<T>(
  file: File,
  task: (zip: ZipArchive) => T | Promise<T>,
): Promise<T> {
  const zip = ZipArchive.open(file)
  try {
    return await task(zip)
  } finally {
    zip.close()
  }
}

/** Junk a packer leaves behind: macOS resource forks and dot-files. */
export function isJunkPath(path: string): boolean {
  return path
    .split('/')
    .some((segment) => segment === '__MACOSX' || segment.startsWith('.'))
}
