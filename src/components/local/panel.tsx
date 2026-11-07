import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/** The card the local sources' controls share: icon, title, body, actions. */
export function Panel({
  icon,
  title,
  label,
  actions,
  className,
  children,
}: {
  icon: ReactNode
  title: string
  label: string
  actions?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'flex items-start gap-3 rounded-lg border border-border bg-card p-3',
        className,
      )}
    >
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="truncate text-sm font-medium">{title}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {children}
        </p>
        {actions && <div className="flex flex-wrap gap-2 pt-1.5">{actions}</div>}
      </div>
    </div>
  )
}
