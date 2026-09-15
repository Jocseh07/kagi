/**
 * MangaDex's API terms: proxy everything, send an honest User-Agent, never
 * spoof a browser. One string, shared by the API and both image routes.
 *
 * The contact is this deployment's own origin (`APP_ORIGIN` in wrangler
 * vars), so MangaDex can reach whoever runs it, with the project page as the
 * fallback for a build that never set one.
 */
import { cloudflareEnv } from './auth'

const PROJECT_URL = 'https://github.com/Jocseh07/kagi'

export function mangadexUserAgent(): string {
  const origin = cloudflareEnv<{ APP_ORIGIN?: string }>().APP_ORIGIN?.trim()
  return `kagi/1.0 (${origin || PROJECT_URL})`
}
