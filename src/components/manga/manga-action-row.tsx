import type { ComponentProps } from 'react'
import type { LucideIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * The strip of primary actions under the series header.
 *
 * Mihon gives every action the same shape — a mark above a short label — so
 * the row reads as one control rather than a scatter of differently weighted
 * buttons, and the active ones are told apart by colour alone. Each action is
 * a column so it can carry a status line underneath without disturbing its
 * neighbours.
 */
export function MangaActionRow({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex items-start gap-1 border-y border-border py-1 md:border-y-0 md:py-0',
        className,
      )}
      {...props}
    />
  )
}

/** One action's column: the button, then anything it has to report. */
export function MangaActionSlot({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex min-w-0 flex-1 basis-0 flex-col items-center gap-1', className)}
      {...props}
    />
  )
}

export function MangaActionButton({
  icon: Icon,
  iconClassName,
  label,
  active = false,
  className,
  children,
  ...props
}: ComponentProps<typeof Button> & {
  icon: LucideIcon
  iconClassName?: string
  label: string
  /** On — favourited, queued, in progress. Colour is the only marker. */
  active?: boolean
}) {
  return (
    <Button
      variant="ghost"
      className={cn(
        'h-auto w-full flex-col gap-1 py-2 text-center text-xs leading-4 font-normal whitespace-normal',
        active ? 'text-primary' : 'text-muted-foreground',
        className,
      )}
      {...props}
    >
      {/* An `asChild` caller supplies its own anchor and repeats the mark and
          the label inside it; everyone else gets them from the props. */}
      {children ?? (
        <>
          <Icon className={cn('size-5 sm:size-4', iconClassName)} />
          {label}
        </>
      )}
    </Button>
  )
}

/** A status line under an action, sized to sit inside its column. */
export function MangaActionNote({
  tone = 'muted',
  className,
  ...props
}: ComponentProps<'p'> & { tone?: 'muted' | 'destructive' }) {
  return (
    <p
      className={cn(
        'text-center text-xs',
        tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}
