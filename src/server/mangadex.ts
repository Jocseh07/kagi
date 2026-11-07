/**
 * MangaDex's API terms: proxy everything, send an honest User-Agent, never
 * spoof a browser. One string, shared by the API and both image routes.
 *
 * The contact is this deployment's own origin (`APP_ORIGIN`), so MangaDex can
 * reach whoever runs it, with the project page as the fallback for a build
 * that never set one.
 */

import * as Effect from 'effect/Effect'

import { Env } from './effect/env'

const PROJECT_URL = 'https://github.com/Jocseh07/kagi'

export const mangadexUserAgent = Effect.map(
  Env,
  (env) => `kagi/1.0 (${env.APP_ORIGIN?.trim() || PROJECT_URL})`,
)
