import { constants } from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'

export async function atomicExport(destination: string, data: Blob | Uint8Array | string): Promise<void> {
  if (!isAbsolute(destination)) throw new Error('Choose an absolute destination path.')
  const temporary = `${destination}.${randomUUID()}.tmp`
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    if (data instanceof Blob) {
      const reader = data.stream().getReader()
      try {
        while (true) {
          const result = await reader.read()
          if (result.done) break
          let offset = 0
          while (offset < result.value.byteLength) {
            const written = await handle.write(result.value, offset, result.value.byteLength - offset)
            if (written.bytesWritten === 0) throw new Error('The export could not make progress writing to disk.')
            offset += written.bytesWritten
          }
        }
      } finally {
        reader.releaseLock()
      }
    } else await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    await rename(temporary, destination)
    const parent = await open(dirname(destination), constants.O_RDONLY | constants.O_DIRECTORY)
    try { await parent.sync() } finally { await parent.close() }
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(temporary, { force: true })
    throw error
  }
}
