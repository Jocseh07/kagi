import type { Source } from './types'

/** The native app has no IndexedDB, so the web-only sources are left out. */
export const webOnlySources: readonly Source[] = []
