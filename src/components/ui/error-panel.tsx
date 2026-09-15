import { CloudOff, ExternalLink, ShieldAlert, TriangleAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { isOnline } from '@/lib/offline/use-online'
import { ChallengeRequiredError, CorsBlockedError } from '@/lib/transport/types'
import { cn } from '@/lib/utils'

export function ErrorPanel({
  error,
  onRetry,
  className,
}: {
  error: unknown
  onRetry?: () => void
  className?: string
}) {
  const kind = kindOf(error)
  const Icon = ICONS[kind]
  // Offline is a state of the device, not a fault of the source: it gets the
  // panel's quiet treatment rather than the destructive edge the refusals do.
  const alarming = kind !== 'unknown' && kind !== 'offline'
  // A retry only helps when the next attempt could go differently. A refused
  // origin needs the user to change something first, so offering one would
  // just fail again on click. A challenge is the opposite case: retrying is
  // the whole point, once the check has been cleared in the other tab.
  const retryable = kind !== 'cors'
  const siteUrl = error instanceof ChallengeRequiredError ? error.siteUrl : null

  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-3 rounded-lg border border-border bg-card p-4',
        alarming && 'border-destructive/40',
        className,
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 size-5 shrink-0',
          alarming ? 'text-destructive' : 'text-muted-foreground',
        )}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium text-foreground">{TITLES[kind]}</p>
        <p className="text-sm text-muted-foreground">{messageOf(error, kind)}</p>
        {HINTS[kind] && (
          <p className="text-xs text-muted-foreground">{HINTS[kind]}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {siteUrl && (
          <Button variant="outline" size="sm" asChild>
            <a href={siteUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="size-4" />
              Open site
            </a>
          </Button>
        )}
        {onRetry && retryable && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            {siteUrl ? 'Try again' : 'Retry'}
          </Button>
        )}
      </div>
    </div>
  )
}

type Kind = 'offline' | 'challenge' | 'cors' | 'unknown'

function kindOf(error: unknown): Kind {
  // Ahead of the rest: with no interface to reach anything, whatever the
  // source threw on the way down describes the symptom and not the cause.
  if (!isOnline()) return 'offline'
  if (error instanceof ChallengeRequiredError) return 'challenge'
  if (error instanceof CorsBlockedError) return 'cors'
  return 'unknown'
}

const ICONS: Record<Kind, typeof TriangleAlert> = {
  offline: CloudOff,
  challenge: ShieldAlert,
  cors: ShieldAlert,
  unknown: TriangleAlert,
}

const TITLES: Record<Kind, string> = {
  offline: "You're offline",
  challenge: "The site wants to check you're human",
  cors: 'Blocked by the browser',
  unknown: 'Could not load this source',
}

const HINTS: Record<Kind, string | null> = {
  // The banner under the header says what still works while offline; this
  // panel only has to account for the one thing that did not.
  offline: null,
  // Deliberately not a promise. The check is cleared in the reader's own
  // browser, while the page is fetched by the dev proxy — a separate client
  // whose cookies we cannot reach — so clearing it helps when the block was
  // by address, and not otherwise.
  challenge:
    'Open the site in a new tab, pass the check there, then come back and ' +
    'try again. If it is still blocked, waiting a minute usually clears it.',
  cors:
    'Nothing is wrong with your connection. A source can refuse one page ' +
    'origin while allowing another, so check the address bar before ' +
    'concluding the source is unreachable.',
  unknown: null,
}

function messageOf(error: unknown, kind: Kind): string {
  // The thrown message here is whatever failed on the way to a network that
  // is not there — a symptom, and never the one the reader needs.
  if (kind === 'offline') return 'This needs a connection to load.'
  if (error instanceof Error) return error.message
  return 'An unexpected error occurred while talking to the source.'
}
