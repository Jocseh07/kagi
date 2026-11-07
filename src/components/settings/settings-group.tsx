import type { ReactNode } from 'react'

import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

/**
 * One titled block of settings: the title sits above the card rather than in a
 * bordered header inside it, and the card is a container so rows lay out by
 * their own width wherever the group lands.
 */
export function SettingsGroup({
  title,
  aside,
  description,
  children,
  className,
}: {
  title: string
  aside?: ReactNode
  description?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-end justify-between gap-3 px-1">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">{title}</h2>
          {description ? (
            <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {aside ? <div className="shrink-0 text-xs text-muted-foreground">{aside}</div> : null}
      </div>
      <div className="@container divide-y divide-border overflow-hidden rounded-lg border border-border bg-card text-card-foreground">
        {children}
      </div>
    </section>
  )
}

/**
 * Label and hint beside the control where the card is wide enough, the control
 * under them where it is not. `inline` keeps a small control, a switch, beside
 * the label at every width.
 */
export function SettingRow({
  id,
  label,
  hint,
  control,
  inline = false,
  className,
}: {
  id?: string
  label: ReactNode
  hint?: ReactNode
  control: ReactNode
  inline?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex gap-3 px-4 py-3',
        inline
          ? 'items-center gap-4'
          : 'flex-col @md:flex-row @md:items-center @md:gap-4',
        className,
      )}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        {id ? (
          <Label htmlFor={id} className="font-normal">
            {label}
          </Label>
        ) : (
          <p className="text-sm">{label}</p>
        )}
        {hint ? (
          <div className="text-xs leading-relaxed text-muted-foreground">{hint}</div>
        ) : null}
      </div>
      <div className={cn('shrink-0', !inline && 'w-full @md:w-auto')}>{control}</div>
    </div>
  )
}
