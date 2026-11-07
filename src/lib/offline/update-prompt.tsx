/**
 * The "new version available" nudge, and the module state behind it.
 *
 * Split out of the app entry because the registration that produces an update
 * callback happens in `src/client.tsx`, before React mounts, while the thing
 * that renders it lives inside the tree. The callback can arrive on either side
 * of the mount, so it is held here rather than in either one.
 */

import { useEffect, useState } from 'react'

import { RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'

type Apply = () => Promise<void>

let pendingUpdate: Apply | null = null
let onUpdate: ((apply: Apply) => void) | null = null

/** Called by the service worker registration when a new worker is waiting. */
export function setPendingUpdate(apply: Apply): void {
  pendingUpdate = apply
  onUpdate?.(apply)
}

/** A reader mid-chapter should not be reloaded out from under; ask instead. */
export function UpdatePrompt() {
  const [apply, setApply] = useState<Apply | null>(() => pendingUpdate)
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    onUpdate = (next) => setApply(() => next)
    return () => {
      onUpdate = null
    }
  }, [])

  if (!apply) return null

  // A bar in the layout's flow, like the offline and incognito ones, so it
  // never sits over the bottom nav or a page's own controls.
  return (
    <div role="status" className="shrink-0 border-b border-border bg-secondary">
      <div className="page-width flex h-9 items-center gap-2 px-page text-xs">
        <RefreshCw aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 truncate font-medium">New version available</p>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={applying}
            onClick={() => {
              setApplying(true)
              void apply().catch(() => setApplying(false))
            }}
          >
            {applying ? 'Reloading…' : 'Reload'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setApply(null)}
          >
            Later
          </Button>
        </div>
      </div>
    </div>
  )
}
