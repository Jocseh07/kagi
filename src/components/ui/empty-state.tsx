import type { ComponentType, ReactNode } from 'react'

import { cn } from '@/lib/utils'

export interface EmptyStateProps {
  icon: ComponentType<{ className?: string }>
  title: string
  description: ReactNode
  /** Optional call to action, rendered under the copy. */
  action?: ReactNode
  className?: string
}

/**
 * The one empty panel. Every page that can have nothing to show uses this, so
 * the dashed box is the same height and the same rhythm wherever it appears.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 py-12 text-center',
        className,
      )}
    >
      <Icon className="size-6 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-base font-medium sm:text-sm">{title}</p>
        <p className="max-w-sm text-base text-muted-foreground sm:text-sm">{description}</p>
      </div>
      {action}
    </div>
  )
}
