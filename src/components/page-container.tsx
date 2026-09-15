import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

/**
 * The page shell: one width cap and one spacing rhythm, both defined as
 * utilities in index.css. Blocks are spaced by the container's own gap, so a
 * block that does not render leaves no space behind it.
 */
export function PageContainer({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'page-width flex flex-col gap-page px-page py-page',
        className,
      )}
      {...props}
    />
  )
}
