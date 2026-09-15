import { useState } from 'react'
import { Download, X } from 'lucide-react'

import { IosInstallDialog } from '@/components/pwa/ios-install-dialog'
import { useInstallOffer } from '@/components/pwa/use-install-offer'
import { Button } from '@/components/ui/button'
import { useInstallDismissed } from '@/lib/pwa/install-dismissed'

/**
 * Offered once, under the header, in the same strip the other app-wide notices
 * use. Dismissing it is permanent: Settings keeps a row that installs at any
 * time, so this only has to ask, never insist.
 */
export function InstallBanner() {
  const { offer, install, installing } = useInstallOffer()
  const [dismissed, dismiss] = useInstallDismissed()
  const [steps, setSteps] = useState(false)

  if (dismissed || offer === 'none') return null

  return (
    <div role="status" className="shrink-0 border-b border-border bg-secondary">
      <div className="page-width flex h-9 items-center gap-2 px-page text-xs">
        <Download aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 truncate font-medium">
          Install Kagi
          <span className="font-normal text-muted-foreground">
            {' on your home screen'}
          </span>
        </p>

        <Button
          size="sm"
          className="ml-auto h-6 shrink-0 px-2 text-xs"
          disabled={installing}
          onClick={() => {
            if (offer === 'instructions') setSteps(true)
            else void install()
          }}
        >
          {installing ? 'Installing' : offer === 'instructions' ? 'Show how' : 'Install'}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 shrink-0 px-0"
          onClick={dismiss}
        >
          <X aria-hidden className="size-3.5" />
          <span className="sr-only">Dismiss</span>
        </Button>
      </div>

      <IosInstallDialog open={steps} onOpenChange={setSteps} />
    </div>
  )
}
