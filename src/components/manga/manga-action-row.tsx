import type { ComponentProps } from 'react'
import type { LucideIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * One segment of the series actions, which sit together in a `ButtonGroup`.
 *
 * Mihon gives every action the same shape, a mark above a short label, so the
 * group reads as one control and the active ones are told apart by colour.
 * Each segment is a direct child of the group so its corners join.
 */
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
      variant="outline"
      className={cn(
        'h-auto min-w-0 flex-1 basis-0 flex-col gap-1 px-1 py-2 text-center text-xs leading-4 font-normal whitespace-normal',
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
