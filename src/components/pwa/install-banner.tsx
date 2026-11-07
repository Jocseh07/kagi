import { useState } from 'react'
import { Download, X } from 'lucide-react'

import { KagiMark } from '@/components/kagi-mark'
import { IosInstallDialog } from '@/components/pwa/ios-install-dialog'
import { useInstallOffer } from '@/components/pwa/use-install-offer'
import { Button } from '@/components/ui/button'
import { ANDROID_DOWNLOAD_PATH } from '@/lib/app-release'
import { useInstallDismissed } from '@/lib/pwa/install-dismissed'
import { useAndroidOffer } from '@/lib/pwa/use-app-release'

/**
 * Offered once, under the header, in the same strip the other app-wide notices
 * use. Dismissing it is permanent: Settings keeps a row that installs at any
 * time, so this only has to ask, never insist.
 *
 * One strip, one ask: on Android with a published build the strip offers the
 * APK, which is the stronger answer, and the web install is left to Settings.
 */
export function InstallBanner() {
  const { offer, install, installing } = useInstallOffer()
  const android = useAndroidOffer()
  const [dismissed, dismiss] = useInstallDismissed()
  const [steps, setSteps] = useState(false)

  if (dismissed || (!android && offer === 'none')) return null

  return (
    <div role="status" className="shrink-0 border-b border-border bg-secondary">
      <div className="page-width flex min-h-12 items-center gap-2 px-page text-xs md:min-h-9">
        <KagiMark className="size-4" />
        {android ? (
          <p className="min-w-0 truncate font-medium">
            Get Kagi for Android
            <span className="hidden font-normal text-muted-foreground sm:inline">
              {' · Saved chapters stay on your phone'}
            </span>
          </p>
        ) : (
          <p className="min-w-0 truncate font-medium">
            Install Kagi
            <span className="font-normal text-muted-foreground">
              {' on your home screen'}
            </span>
          </p>
        )}

        {android ? (
          <Button asChild size="sm" className="ml-auto h-10 shrink-0 px-3 text-xs md:h-6 md:px-2">
            <a href={ANDROID_DOWNLOAD_PATH} download>
              <Download aria-hidden />
              Download
            </a>
          </Button>
        ) : (
          <Button
            size="sm"
            className="ml-auto h-10 shrink-0 px-3 text-xs md:h-6 md:px-2"
            disabled={installing}
            onClick={() => {
              if (offer === 'instructions') setSteps(true)
              else void install()
            }}
          >
            {installing ? 'Installing' : offer === 'instructions' ? 'Show how' : 'Install'}
          </Button>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="size-10 shrink-0 px-0 md:size-6"
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
