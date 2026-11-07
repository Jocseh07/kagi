import { readFileSync, readlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isJournalId } from '../../../src/lib/adapt/journal/helpers'
import { dataRoot } from './database'
import { getSecret, setSecret } from './preferences'
const INSTALLATION_KEY = 'native.journal.owner'
interface ProcessIdentity { boot: string; namespace: string; started: string }
let processIdentity: ProcessIdentity | undefined
let installation: {root:string;promise:Promise<string>} | undefined
function processStart(stat: string): string {
  const value = stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[19]
  if (!value || !/^\d+$/.test(value)) throw new Error('Cannot determine the native journal process identity.')
  return value
}
function localIdentity(): ProcessIdentity {
  if (processIdentity) return processIdentity
  const boot = readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()
  const namespace = /^pid:\[(\d+)\]$/.exec(readlinkSync('/proc/self/ns/pid'))?.[1]
  if (!isJournalId(boot) || !namespace) throw new Error('Native journal ownership requires Linux procfs.')
  processIdentity = {boot,namespace,started:processStart(readFileSync('/proc/self/stat','utf8'))}
  return processIdentity
}
async function installationId(): Promise<string> {
  const root = dataRoot()
  if (installation?.root === root) return installation.promise
  const promise = (async () => {
    const stored = await getSecret(INSTALLATION_KEY)
    if (stored) {
      if (!isJournalId(stored)) throw new Error('The native journal installation identity is invalid.')
      return stored
    }
    const created = crypto.randomUUID()
    await setSecret(INSTALLATION_KEY,created)
    return created
  })()
  installation = {root,promise}
  void promise.catch(() => { if (installation?.promise === promise) installation = undefined })
  return promise
}
export async function nativeJournalOwner(original: string): Promise<string> {
  const current = localIdentity()
  return `rune:${await installationId()}:${current.boot}:${current.namespace}:${process.pid}:${current.started}:${original.replace(/^node:/,'')}`
}
/** Requires the application data lock; matching process identities or this installation's prior boot prove death. */
export async function journalOwnerState(owner: string): Promise<'alive' | 'dead' | 'unknown'> {
  const match = /^rune:([^:]+):([^:]+):(\d+):(\d+):(\d+):.+$/.exec(owner)
  if (!match || !isJournalId(match[1]) || !isJournalId(match[2])) return 'unknown'
  const pid = Number(match[4]); if (!Number.isSafeInteger(pid) || pid < 1) return 'unknown'
  let current: ProcessIdentity
  try { current = localIdentity() } catch { return 'unknown' }
  if (match[2] !== current.boot) {
    try { return await getSecret(INSTALLATION_KEY) === match[1] ? 'dead' : 'unknown' } catch { return 'unknown' }
  }
  if (match[3] !== current.namespace) return 'unknown'
  try {
    return processStart(await readFile(`/proc/${pid}/stat`,'utf8')) === match[5] ? 'alive' : 'dead'
  } catch (error) { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT' ? 'dead' : 'unknown' }
}
