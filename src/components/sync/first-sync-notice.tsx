import { RefreshCw } from 'lucide-react'

import { cn } from '@/lib/utils'

/** Sits above the skeleton a page draws while the first sync fills it. */
export function FirstSyncNotice({ className }: { className?: string }) {
  return (
    <p
      role="status"
      className={cn('flex items-center gap-2 text-sm text-muted-foreground', className)}
    >
      <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" />
      Syncing your library…
    </p>
  )
}
