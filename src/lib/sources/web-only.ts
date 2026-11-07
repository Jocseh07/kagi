import { AdaptedSource } from './adapted'
import type { Source } from './types'

/** Sources only the web can run: adaptations store their pages in IndexedDB. */
export const webOnlySources: readonly Source[] = [new AdaptedSource()]
