import { CloudOff } from 'lucide-react'

import { useOnline } from '@/lib/offline/use-online'

/**
 * Sits directly below the header for as long as the connection is gone. Not
 * dismissible: it is true until it is not, and the pages that stop working
 * while it shows are the ones the reader is about to try.
 *
 * Guttered like the header and the pages so its text lines up with the brand
 * above it, and shaped like `IncognitoBanner` so two bars can never stack into
 * two different rows.
 */
export function OfflineBanner() {
  const online = useOnline()

  if (online) return null

  return (
    <div role="status" className="shrink-0 border-b border-border bg-secondary">
      <div className="page-width flex h-9 items-center gap-2 px-page text-xs">
        <CloudOff aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 truncate font-medium">
          Offline
          <span className="font-normal text-muted-foreground">
            {' — your library and downloaded chapters still work.'}
          </span>
        </p>
      </div>
    </div>
  )
}
