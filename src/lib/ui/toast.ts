/**
 * The app's one voice for "that worked" and "that did not".
 *
 * Every call site goes through here rather than through sonner directly, so
 * durations, error unwrapping and the destructive styling are decided once.
 * The rule for what belongs in a toast: a *moment* that could be missed — a
 * queued download, a series added, a row removed. A lasting condition is not a
 * moment, so page-load failures stay in `ErrorPanel` and a setting that refuses
 * to save keeps saying so inline.
 */
import { toast } from 'sonner'
import type { ReactNode } from 'react'

/** Long enough to read a short line, short enough to stay out of the way. */
const SUCCESS_MS = 3500

export interface NotifyOptions {
  /** Stable id, so a repeated action replaces its toast instead of stacking. */
  id?: string
  description?: ReactNode
  action?: { label: string; onClick: () => void }
}

function success(message: string, options: NotifyOptions = {}): void {
  toast.success(message, { duration: SUCCESS_MS, ...options })
}

/**
 * Failures do not expire. A success is a receipt the user can ignore; a
 * failure is something they have to know about, and dismissing it should be
 * their decision rather than a timer's.
 */
function error(message: string, cause?: unknown, options: NotifyOptions = {}): void {
  toast.error(message, {
    duration: Number.POSITIVE_INFINITY,
    description: cause === undefined ? undefined : messageOf(cause),
    ...options,
  })
}

/**
 * A question with one button on it — used where an action implies a follow-up
 * the user probably wants but never asked for.
 */
function ask(message: string, options: NotifyOptions & { action: NotifyOptions['action'] }): void {
  toast(message, { duration: 8000, ...options })
}

export const notify = { success, error, ask }

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'unknown error'
}
