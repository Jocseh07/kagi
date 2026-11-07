import { chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { exec, sqliteTransaction } from './database'
import { getSetting, setSetting } from '../../../src/lib/db/repositories'
import { atomicWrite, ensureDirectory, isMissing, readBytes, storageKey, storageRoot, syncDirectory } from './storage'
const listeners = new Set<(key:string) => void>()
const PRIVATE_KEY = 'adapt.apiKey'
export function apiKeyPath(): string { return join(storageRoot(),'private','api-key') }
export function secretPath(key: string): string { return key === PRIVATE_KEY ? apiKeyPath() : join(storageRoot(),'private',storageKey(key)) }
export async function getSecret(key: string): Promise<string | undefined> {
  try { return new TextDecoder().decode(await readBytes(secretPath(key))) }
  catch (error) { if (isMissing(error)) return undefined; throw error }
}
export async function setSecret(key: string, value: string): Promise<void> {
  const directory = await ensureDirectory(join(storageRoot(),'private')); await chmod(directory,0o700)
  if (value) { await atomicWrite(secretPath(key),value); await chmod(secretPath(key),0o600) }
  else { await rm(secretPath(key),{force:true}); await syncDirectory(directory) }
  for (const listener of listeners) listener(key)
}
export async function getPreference(key: string): Promise<string | null> {
  if (key === PRIVATE_KEY) throw new Error('Use getSecret() for the private API key.')
  return getSetting(key)
}
export async function setPreference(key: string, value: string): Promise<void> {
  if (key === PRIVATE_KEY) throw new Error('Use setSecret() for the private API key.')
  await setSetting(key,value)
  for (const listener of listeners) listener(key)
}
export async function deletePreference(key: string): Promise<void> { await setPreference(key,'') }
export async function getPreferences(): Promise<Record<string,string>> {
  return Object.fromEntries((await exec('SELECT key,value FROM settings WHERE key <> ? ORDER BY key',[PRIVATE_KEY])).rows.map((row) => [String(row[0]),String(row[1])]))
}
export async function setPreferences(values: Readonly<Record<string,string>>): Promise<void> {
  if (PRIVATE_KEY in values) throw new Error('API keys cannot be imported through preferences.')
  await sqliteTransaction(async () => { for (const [key,value] of Object.entries(values)) { if (typeof value !== 'string') throw new Error('Preference values must be strings.'); await setSetting(key,value) } })
  for (const key of Object.keys(values)) for (const listener of listeners) listener(key)
}
export function subscribePreferences(listener: (key:string) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }
export async function exportPreferences(): Promise<string> { return JSON.stringify(await getPreferences()) }
export async function importPreferences(serialized: string): Promise<void> {
  const values: unknown = JSON.parse(serialized)
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.values(values).some((value) => typeof value !== 'string') || Object.keys(values).some((key) => ['__proto__','constructor','prototype',PRIVATE_KEY].includes(key))) throw new Error('Invalid preferences file.')
  await setPreferences(values as Record<string,string>)
}
