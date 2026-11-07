import { CloudOff, DatabaseZap, ExternalLink, ShieldAlert, TriangleAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { DbError } from '@/lib/db/client'
import { isOnline } from '@/lib/offline/use-online'
import { ChallengeRequiredError, CorsBlockedError } from '@/lib/transport/types'
import { describeError } from '@/lib/ui/describe-error'
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
  const message = kind === 'offline' ? 'This needs a connection to load.' : describeError(error)

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
        <p className="text-base text-muted-foreground sm:text-sm">{message}</p>
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
        {!onRetry && kind === 'library' && (
          <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
            Reload
          </Button>
        )}
      </div>
    </div>
  )
}

type Kind = 'offline' | 'challenge' | 'cors' | 'library' | 'unknown'

function kindOf(error: unknown): Kind {
  // The library is local, so a connection has nothing to do with it failing.
  if (error instanceof DbError) return 'library'
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
  library: DatabaseZap,
  unknown: TriangleAlert,
}

const TITLES: Record<Kind, string> = {
  offline: "You're offline",
  challenge: 'Human check needed',
  cors: 'Blocked by the browser',
  library: 'Library unavailable',
  unknown: 'Could not load',
}
