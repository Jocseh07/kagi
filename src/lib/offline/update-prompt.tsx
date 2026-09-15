/**
 * The "new version available" nudge, and the module state behind it.
 *
 * Split out of the app entry because the registration that produces an update
 * callback happens in `src/client.tsx`, before React mounts, while the thing
 * that renders it lives inside the tree. The callback can arrive on either side
 * of the mount, so it is held here rather than in either one.
 */

import { useEffect, useState } from 'react'

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

  return (
    <div
      role="status"
      // Above the reader, which is a fixed z-50 surface.
      className="fixed right-4 bottom-4 z-[60] flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 shadow-lg"
    >
      <span className="text-sm">New version available</span>
      <Button
        size="sm"
        disabled={applying}
        onClick={() => {
          setApplying(true)
          void apply().catch(() => setApplying(false))
        }}
      >
        {applying ? 'Reloading…' : 'Reload'}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setApply(null)}>
        Later
      </Button>
    </div>
  )
}
