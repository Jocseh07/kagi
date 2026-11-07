// Background Fetch is a browser service; native saves go through save-chapter.native.ts.

import type { CachePageOutcome, CachePagesProgress } from './register'

export interface BackgroundFetchOptions {
  id: string
  urls: readonly string[]
  title: string
  signal?: AbortSignal
  onProgress?(progress: CachePagesProgress): void
}

export function supportsBackgroundFetch(): boolean {
  return false
}

export function backgroundFetchIdFor(chapterId: string): string {
  return `chapter:${chapterId}`
}

export async function runBackgroundFetch(
  options: BackgroundFetchOptions,
): Promise<CachePageOutcome[]> {
  throw new Error(`Background downloads are not available here (${options.id}).`)
}

export async function primeBackgroundFetch(
  options: Pick<BackgroundFetchOptions, 'id' | 'urls' | 'title'>,
): Promise<void> {
  void options
}

export async function takeCachedBody(id: string, url: string): Promise<string | null> {
  void id
  void url
  return null
}

export async function cancelBackgroundFetch(id: string): Promise<void> {
  void id
}
