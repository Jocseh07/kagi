import { useState } from 'react'
import { Check } from 'lucide-react'

import { IosInstallDialog } from '@/components/pwa/ios-install-dialog'
import { useInstallOffer } from '@/components/pwa/use-install-offer'
import { useStoragePersistence } from '@/components/storage/use-storage-persistence'
import { Button } from '@/components/ui/button'

/**
 * The permanent way in, since the banner can be dismissed for good. Sits in
 * Data because installing is what earns the app storage the browser will not
 * clear, which is the rest of this tab's subject: hence asking for persistence
 * again the moment an install lands, rather than leaving the notice above
 * standing until the next reload.
 */
export function InstallPanel() {
  const storage = useStoragePersistence()
  const { offer, standalone, install, installing } = useInstallOffer(storage.request)
  const [steps, setSteps] = useState(false)

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">Install</h2>
      </header>

      <div className="flex items-center justify-between gap-3 px-4 py-4">
        {standalone ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Check aria-hidden className="size-4 shrink-0" />
            Installed
          </p>
        ) : (
          <>
            <p className="min-w-0 text-sm text-muted-foreground">
              {offer === 'none'
                ? 'This browser cannot install the app. Chrome, Edge and Safari can.'
                : 'Opens from your home screen and works offline.'}
            </p>
            {offer !== 'none' && (
              <Button
                size="sm"
                className="shrink-0"
                disabled={installing}
                onClick={() => {
                  if (offer === 'instructions') setSteps(true)
                  else void install()
                }}
              >
                {installing
                  ? 'Installing'
                  : offer === 'instructions'
                    ? 'Show how'
                    : 'Install'}
              </Button>
            )}
          </>
        )}
      </div>

      <IosInstallDialog open={steps} onOpenChange={setSteps} />
    </section>
  )
}
