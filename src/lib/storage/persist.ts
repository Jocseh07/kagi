/**
 * Storage persistence. Without it the origin's OPFS data — including the SQLite
 * database — is evictable under storage pressure.
 */

export interface StorageUsage {
  usage: number
  quota: number
  /** 0..1, or 0 when the quota is unknown. */
  ratio: number
}

/**
 * Result of asking for persistence. `denied` covers both a refusal and a
 * throw: from the caller's side there is nothing to tell apart, and either way
 * the data stays evictable.
 */
export type PersistOutcome = 'granted' | 'denied' | 'unsupported'

/**
 * Whether the browser will prompt, has already blocked, or decides silently.
 * `unknown` means the Permissions API is missing or does not recognise the
 * descriptor, which is not the same as a refusal.
 */
export type PersistPermission = 'granted' | 'denied' | 'prompt' | 'unknown'

function storageManager(): StorageManager | undefined {
  if (typeof navigator === 'undefined') return undefined
  return navigator.storage as StorageManager | undefined
}

export function supportsPersistence(): boolean {
  const storage = storageManager()
  return (
    typeof storage?.persist === 'function' &&
    typeof storage.persisted === 'function'
  )
}

export function supportsEstimate(): boolean {
  return typeof storageManager()?.estimate === 'function'
}

export async function isPersisted(): Promise<boolean> {
  const storage = storageManager()
  if (typeof storage?.persisted !== 'function') return false
  try {
    return await storage.persisted()
  } catch {
    return false
  }
}

/**
 * Requests persistent storage. Chromium decides silently from heuristics
 * (bookmarked, site engagement, installed, notifications) and never prompts, so
 * a refusal here repeats on every retry until one of those changes. Firefox
 * prompts instead.
 */
export async function requestPersistence(): Promise<PersistOutcome> {
  const storage = storageManager()
  if (typeof storage?.persist !== 'function') return 'unsupported'
  try {
    if (await isPersisted()) return 'granted'
    return (await storage.persist()) ? 'granted' : 'denied'
  } catch {
    return 'denied'
  }
}

/** Boot path: request once, without caring why it failed. */
export async function persist(): Promise<boolean> {
  return (await requestPersistence()) === 'granted'
}

/**
 * Lets a refusal be explained: a blocked permission needs the browser's own
 * site settings, while `prompt` means the browser simply has not been
 * convinced yet.
 */
export async function permissionState(): Promise<PersistPermission> {
  if (typeof navigator === 'undefined' || !navigator.permissions) return 'unknown'
  try {
    const status = await navigator.permissions.query({ name: 'persistent-storage' })
    return status.state
  } catch {
    return 'unknown'
  }
}

export async function estimate(): Promise<StorageUsage | null> {
  const storage = storageManager()
  if (typeof storage?.estimate !== 'function') return null
  try {
    const { usage = 0, quota = 0 } = await storage.estimate()
    return { usage, quota, ratio: quota > 0 ? usage / quota : 0 }
  } catch {
    return null
  }
}
