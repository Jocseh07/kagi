import type { ButtonHTMLAttributes, ReactNode } from 'react'

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

/**
 * Reader-local primitives.
 *
 * The reader shell carries `.dark`, so the shared shadcn tokens already resolve
 * to the chosen theme's dark palette inside it. These compose those tokens
 * rather than holding values of their own — the theme is swapped at runtime.
 */

const BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-md text-sm ' +
  'font-medium whitespace-nowrap transition-colors ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-ring ' +
  'disabled:pointer-events-none disabled:opacity-40'

const VARIANTS = {
  solid: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  ghost: 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
  accent: 'bg-primary text-primary-foreground hover:bg-primary/90',
} as const

interface ToolbarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANTS
}

export function ToolbarButton({
  variant = 'ghost',
  className = '',
  type = 'button',
  ...props
}: ToolbarButtonProps) {
  // Merged rather than concatenated: Tailwind emits conflicting utilities in
  // its own order, not the order they appear in the string, so a caller's
  // `rounded-full` would lose to the `rounded-md` above. `cn` resolves the
  // conflict by position instead, which is what makes an override an override.
  return (
    <button
      type={type}
      className={cn(BASE, 'h-8 px-2.5', VARIANTS[variant], className)}
      {...props}
    />
  )
}

interface ToolbarSelectProps {
  /** Names the control for assistive tech; there is no visible label. */
  label: string
  value: string
  disabled?: boolean
  onValueChange(value: string): void
  /** `SelectItem`s. */
  children: ReactNode
  className?: string
}

/**
 * The reader's dropdown.
 *
 * Composes the shared shadcn `Select` so it matches every other dropdown in the
 * app. The popover itself is portalled outside the reader shell, so it must
 * rely only on global tokens — `bg-popover` resolves to the same dark surface
 * the toolbar uses.
 */
export function ToolbarSelect({
  label,
  value,
  disabled,
  onValueChange,
  children,
  className = '',
}: ToolbarSelectProps) {
  return (
    <Select value={value} disabled={disabled} onValueChange={onValueChange}>
      <SelectTrigger
        aria-label={label}
        disabled={disabled}
        className={
          'h-8 max-w-[14rem] rounded-md border-border ' +
          'bg-secondary text-secondary-foreground ' +
          className
        }
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>{children}</SelectGroup>
      </SelectContent>
    </Select>
  )
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-2 text-muted-foreground">
      <div
        className="size-6 animate-spin rounded-full border-2 border-border border-t-primary"
        role="progressbar"
        aria-label={label}
      />
      <span className="text-xs">{label}</span>
    </div>
  )
}

/** An honest failure panel: the real reason, and the action that may fix it. */
export function ErrorPanel({
  title,
  detail,
  children,
}: {
  title: string
  detail: string
  children?: ReactNode
}) {
  return (
    <div
      role="alert"
      className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-lg border border-border bg-card p-6 text-center"
    >
      <p className="text-sm font-medium text-card-foreground">{title}</p>
      <p className="text-xs leading-relaxed text-muted-foreground">{detail}</p>
      {children ? (
        <div className="flex flex-wrap justify-center gap-2 pt-1">{children}</div>
      ) : null}
    </div>
  )
}
