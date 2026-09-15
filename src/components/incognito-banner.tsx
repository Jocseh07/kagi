import { EyeOff } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useIncognito } from '@/lib/incognito/store'

/**
 * Sits directly below the header while incognito is on, for as long as it is
 * on: the one thing worse than not recording your reading is not knowing that
 * it is not being recorded. Guttered like the header and the pages so its text
 * lines up with the brand above it.
 */
export function IncognitoBanner() {
  const [incognito, setIncognito] = useIncognito()

  if (!incognito) return null

  return (
    <div role="status" className="shrink-0 border-b border-border bg-secondary">
      <div className="page-width flex h-9 items-center gap-2 px-page text-xs">
        <EyeOff aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 truncate font-medium">
          Incognito
          <span className="font-normal text-muted-foreground">
            {' — nothing is saved. History and reading progress are not recorded.'}
          </span>
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-6 shrink-0 px-2 text-xs"
          onClick={() => setIncognito(false)}
        >
          Turn off
        </Button>
      </div>
    </div>
  )
}
