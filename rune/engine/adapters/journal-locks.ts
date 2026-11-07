import { dlopen, read } from 'bun:ffi'
import { constants } from 'node:fs'
import { lstat, open, readdir, readlink, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isJournalId } from '../../../src/lib/adapt/journal/helpers'
function openFlock() {
  if (process.platform !== 'linux') throw new Error('Native journal locking currently requires Linux.')
  return dlopen('libc.so.6', {flock:{args:['i32','i32'],returns:'i32'},__errno_location:{args:[],returns:'ptr'}})
}
let library: ReturnType<typeof openFlock> | undefined
async function recoverTemporaries(root: string, id: string): Promise<void> {
  for (const child of ['', 'requests', 'responses', 'artifacts']) {
    const path = child ? join(root,id,child) : join(root,id)
    let info
    try { info = await lstat(path) }
    catch (error) { if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') continue; throw error }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe journal recovery directory.')
    let removed = false
    for (const entry of await readdir(path,{withFileTypes:true})) {
      if (!entry.isFile()) continue
      const match = /^(.+)\.([a-f0-9-]{36})\.tmp$/i.exec(entry.name)
      if (!match || !isJournalId(match[2])) continue
      const target = match[1]
      const json = target.endsWith('.json') && isJournalId(target.slice(0,-5))
      const bin = target.endsWith('.bin') && isJournalId(target.slice(0,-4))
      const owned = child === '' ? target === 'manifest.json' || target === 'events.jsonl'
        : child === 'artifacts' ? json || bin : json || (child === 'requests' && target === 'original.json')
      if (!owned) continue
      await rm(join(path,entry.name),{force:true}); removed = true
    }
    if (removed) {
      const directory = await open(path,constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { await directory.sync() } finally { await directory.close() }
    }
  }
}
export async function withNativeJournalLock<T>(root: string, id: string, action: () => Promise<T>): Promise<T> {
  if (!isJournalId(id)) throw new Error('Invalid generation or artifact ID.')
  library ??= openFlock()
  const file = await open(join(root,`.journal-${id.slice(0,2).toLowerCase()}.flock`),constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,0o600)
  const deadline = Date.now()+10_000
  let acquired = false; let claimed = false; let recovered = false
  const path = join(root,`${id}.lock`); const marker = `.${id}.rune-native-lock`
  try {
    if (!(await file.stat()).isFile()) throw new Error('Unsafe journal lock file.')
    while (library.symbols.flock(file.fd,2 | 4) !== 0) {
      const address = library.symbols.__errno_location()
      if (!address) throw new Error('Cannot read the native journal lock error.')
      const errno = read.i32(address)
      if (errno !== 11 && errno !== 4) throw new Error(`Native journal locking failed (${errno}).`)
      if (Date.now() >= deadline) throw new Error('The journal is busy. Retry after other writers finish.')
      await delay(25)
    }
    acquired = true
    for (;;) {
      try { await symlink(marker,path); claimed = true }
      catch (error) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error
        try {
          if ((await lstat(path)).isSymbolicLink() && await readlink(path) === marker) { await rm(path); recovered = true; continue }
        } catch (inspect) { if (!(typeof inspect === 'object' && inspect !== null && 'code' in inspect && inspect.code === 'ENOENT')) throw inspect }
      }
      if (claimed) {
        const claims = await readdir(root)
        if (!claims.some((name) => name.startsWith(`${id}.browser-`) && name.endsWith('.lock'))) break
        await rm(path); claimed = false
      }
      if (Date.now() >= deadline) throw new Error('The journal is busy. Close other writers before removing stale browser or desktop locks.')
      await delay(25)
    }
    if (recovered) await recoverTemporaries(root,id)
    return await action()
  } finally {
    try { if (claimed) await rm(path,{force:true}) }
    finally { if (acquired) library.symbols.flock(file.fd,8); await file.close() }
  }
}
