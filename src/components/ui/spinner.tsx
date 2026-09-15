import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const spinner = cva(
  // `currentColor` on purpose: the ring takes the colour of whatever text it
  // sits in, so one primitive serves muted captions, primary buttons and the
  // boot screen without a variant per palette slot.
  'inline-block shrink-0 animate-spin rounded-full border-current border-t-transparent motion-reduce:animate-none',
  {
    variants: {
      size: {
        sm: 'size-3.5 border-[1.5px]',
        default: 'size-5 border-2',
        lg: 'size-8 border-[3px]',
      },
    },
    defaultVariants: { size: 'default' },
  },
)

export interface SpinnerProps
  extends React.ComponentProps<'span'>,
    VariantProps<typeof spinner> {}

/**
 * The one spinner. Decorative by default — the wait is announced by whatever
 * region wraps it (see `LoadingScreen`), not by the ring itself, so a screen
 * reader hears the message once rather than twice.
 */
export function Spinner({ className, size, ...props }: SpinnerProps) {
  return (
    <span
      data-slot="spinner"
      aria-hidden
      className={cn(spinner({ size }), className)}
      {...props}
    />
  )
}
