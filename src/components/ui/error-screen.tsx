import { Link, useRouter } from '@tanstack/react-router'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { Compass, Library, RotateCw, TriangleAlert } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

function Screen({
  icon: Icon,
  title,
  description,
  actions,
  details,
  tone = 'destructive',
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  description: ReactNode
  actions: ReactNode
  details?: ReactNode
  tone?: 'destructive' | 'muted'
}) {
  return (
    <div
      role="alert"
      className="flex min-h-full flex-1 items-center justify-center p-6"
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-center">
        <div
          className={cn(
            'mx-auto flex size-12 items-center justify-center rounded-full bg-secondary',
            tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          <Icon className="size-6" />
        </div>
        <h1 className="mt-3 text-base font-semibold text-foreground">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {actions}
        </div>
        {details}
      </div>
    </div>
  )
}

/**
 * What a thrown route renders instead of the page.
 *
 * Retry does two things because a route failure has two halves: `reset` clears
 * the boundary so the component may mount again, and `invalidate` throws away
 * the router's memory of the failed match so the attempt is genuinely fresh
 * rather than a replay of the same rejected state.
 */
export function RouteErrorScreen({ error, reset }: ErrorComponentProps) {
  const router = useRouter()

  return (
    <Screen
      icon={TriangleAlert}
      title="Something went wrong"
      description="This page could not be loaded. It is usually temporary — trying again often clears it."
      actions={
        <>
          <Button
            size="lg"
            onClick={() => {
              reset()
              void router.invalidate()
            }}
          >
            <RotateCw className="size-4" />
            Try again
          </Button>
          <Button size="lg" variant="outline" asChild>
            <Link to="/library">
              <Library className="size-4" />
              Go to library
            </Link>
          </Button>
        </>
      }
      details={
        // Only in development: the message is written for whoever is fixing
        // it, not for the reader, and a stack in production reads as breakage.
        import.meta.env.DEV && error instanceof Error ? (
          <details className="mt-4 text-left">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Error details
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap text-muted-foreground">
              {error.stack ?? error.message}
            </pre>
          </details>
        ) : null
      }
    />
  )
}

/** What an address matching no route renders. */
export function NotFoundScreen() {
  return (
    <Screen
      tone="muted"
      icon={Compass}
      title="Page not found"
      description="That address does not lead anywhere in Kagi. It may have been renamed, or the link that brought you here may be out of date."
      actions={
        <>
          <Button size="lg" asChild>
            <Link to="/library">
              <Library className="size-4" />
              Go to library
            </Link>
          </Button>
          <Button size="lg" variant="outline" asChild>
            <Link to="/browse">
              <Compass className="size-4" />
              Browse sources
            </Link>
          </Button>
        </>
      }
    />
  )
}
