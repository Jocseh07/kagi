import type { BackgroundFetchOptions } from '../../../src/lib/offline/background-fetch'
import type { CachePageOutcome } from '../../../src/lib/offline/register'
import { cancelNativeOfflineJob } from './offline'
import { getBlob, deleteBlob } from './storage'
export type { BackgroundFetchOptions }
export function supportsBackgroundFetch(): boolean { return false }
export function backgroundFetchIdFor(chapterId: string): string { return `chapter:${chapterId}` }
export async function runBackgroundFetch(options: BackgroundFetchOptions): Promise<CachePageOutcome[]> { throw new Error(`Browser Background Fetch is unavailable in Rune (${options.id}). Use the native download queue.`) }
export async function primeBackgroundFetch(options: Pick<BackgroundFetchOptions,'id' | 'urls' | 'title'>): Promise<void> { throw new Error(`Browser Background Fetch cannot prime ${options.id}. The native queue fetches chapters directly.`) }
export async function takeCachedBody(id: string, url: string): Promise<string | null> {
  const key = `background-body:${id}:${url}`
  const blob = await getBlob(key); if (!blob) return null
  const text = await blob.text(); await deleteBlob(key); return text
}
export async function cancelBackgroundFetch(id: string): Promise<void> {
  if (!id.startsWith('chapter:')) throw new Error('Invalid native chapter download ID.')
  cancelNativeOfflineJob(id.slice(8))
}
