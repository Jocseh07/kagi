import { dlopen, FFIType } from 'bun:ffi'
import { constants, openSync, closeSync } from 'node:fs'
import { mkdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'

const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8

export async function acquireEngineLock(root: string): Promise<() => void> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const directory = await lstat(root)
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) throw new Error('Choose a private app data directory with permissions 0700.')
  const native = dlopen('libc.so.6', { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } })
  const descriptor = openSync(join(root, '.engine.lock'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  if (native.symbols.flock(descriptor, LOCK_EX | LOCK_NB) !== 0) {
    closeSync(descriptor)
    native.close()
    throw new Error('Kagi is already using this library. Return to its open window.')
  }
  let released = false
  return () => {
    if (released) return
    released = true
    native.symbols.flock(descriptor, LOCK_UN)
    closeSync(descriptor)
    native.close()
  }
}
