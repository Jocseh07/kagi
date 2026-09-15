import { CloudOff, Smartphone } from 'lucide-react'
import type { ReactNode } from 'react'

import { supportsBackgroundFetch } from '@/lib/offline/background-fetch'
import { supportsOfflineSave } from '@/lib/offline/types'

/** Explains, before the user queues anything, what this browser can do. */
export function OfflineSupportNotice() {
  if (!supportsOfflineSave()) {
    return (
      <Notice
        icon={<CloudOff className="size-4" />}
        title="Offline saving is unavailable"
      >
        This browser has no service worker or Cache API support, so pages cannot
        be kept for offline reading. Items added to the queue will fail.
      </Notice>
    )
  }

  // Background Fetch is what lets a download outlive the page. Without it the
  // queue is only ever as alive as this tab, and saying so up front is better
  // than a user coming back to a queue that made no progress.
  if (!supportsBackgroundFetch()) {
    return (
      <Notice
        icon={<Smartphone className="size-4" />}
        title="Keep this tab open while downloading"
      >
        This browser cannot hand downloads to the system, so the queue only runs
        while the app is open. It slows right down in a hidden tab and stops on a
        phone with the screen off. Anything already downloaded is kept, and the
        queue picks up where it left off when you come back.
      </Notice>
    )
  }

  return null
}

function Notice({
  icon,
  title,
  children,
}: {
  icon: ReactNode
  title: string
  children: ReactNode
}) {
  return (
    <div
      role="note"
      className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
    >
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>
      </div>
    </div>
  )
}
