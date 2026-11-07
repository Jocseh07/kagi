import { AdaptApiError, PROMPT_BLOCKED, SHEET_BLOCKED } from '@/lib/adapt/client'
import { DbError } from '@/lib/db/client'
import { isOnline } from '@/lib/offline/use-online'
import {
  ChallengeRequiredError,
  CorsBlockedError,
  HttpStatusError,
} from '@/lib/transport/types'

/**
 * The sentence a reader sees for a failure, followed by the error's own
 * message so the specific cause is always on screen.
 */
export function describeError(error: unknown): string {
  const sentence = summarize(error)
  const detail = detailOf(error)
  if (!detail) return sentence ?? FALLBACK
  if (!sentence) return detail
  return sentence.includes(detail) ? sentence : `${sentence} (${detail})`
}

function summarize(error: unknown): string | null {
  if (error instanceof DbError) return describeDbError(error)
  if (!isOnline()) return "You're offline. Reconnect and try again."
  if (error instanceof ChallengeRequiredError) {
    return 'The site wants a human check. Open it, pass the check, then try again.'
  }
  if (error instanceof CorsBlockedError) {
    return 'The browser blocked the reply from this site.'
  }
  if (error instanceof HttpStatusError) return describeStatus(error.status)
  if (error instanceof AdaptApiError) return describeAdaptError(error)
  if (!(error instanceof Error)) return null
  // Matched by name: importing the backup parser here would put it in every bundle.
  if (error.name === 'BackupFormatError') return error.message
  if (error.name === 'QuotaExceededError') {
    return 'Storage is full. Free space in Settings, then try again.'
  }
  if (error.name === 'AbortError') return 'Cancelled.'
  if (error instanceof TypeError) {
    return 'Could not reach the site. Check your connection.'
  }
  return null
}

function detailOf(error: unknown): string | null {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return null
    return error.message.trim() || null
  }
  if (typeof error === 'string') return error.trim() || null
  return null
}

const FALLBACK = 'Something went wrong. Try again.'

function describeStatus(status: number): string {
  if (status === 404) return 'The site has no page at that address.'
  if (status === 429) return 'The site is limiting requests. Wait a minute, then try again.'
  if (status >= 500) return 'The site is having trouble. Try again later.'
  return 'The site refused the request.'
}

function describeDbError(error: DbError): string {
  if (error.code === 'MULTI_TAB') return 'Your library is open in another tab.'
  if (error.code === 'UNSUPPORTED') return 'This browser cannot store your library.'
  return 'Your library could not be read. Reload the page.'
}

function describeAdaptError({ status, code, subject }: AdaptApiError): string {
  if (code === PROMPT_BLOCKED) return 'The image filter blocked this panel even toned down. Edit the scene in Script, then retry.'
  if (code === SHEET_BLOCKED) return `The image filter blocked the ${subject} sheet even toned down. Edit its description, then retry.`
  if (code === 'moderation_blocked') return 'The image safety filter blocked an image. Retry draws it again.'
  if (status === 401 || status === 403) {
    return 'The drawing service rejected your key. Check it in Settings.'
  }
  if (status === 429) return 'The drawing service is busy. Try again shortly.'
  return 'The drawing service failed. Try again.'
}
