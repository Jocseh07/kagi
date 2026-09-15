import { ShieldAlert } from 'lucide-react'

import { useInstallOffer } from '@/components/pwa/use-install-offer'
import {
  describeOutcome,
  useStoragePersistence,
} from '@/components/storage/use-storage-persistence'

/**
 * Says that everything a reader downloads sits in storage the browser is
 * allowed to delete, and points at installing as the way out. Silent once
 * persistence is granted; there is nothing left to warn about.
 *
 * The warning only. The install button lives in the panel directly below,
 * which also asks for persistence again once the install lands.
 */
export function StoragePersistenceNotice() {
  const storage = useStoragePersistence()
  const install = useInstallOffer()

  if (storage.loading || storage.persisted) return null

  const canInstall = install.offer !== 'none'

  return (
    <div
      role="note"
      className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
    >
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">Downloads can be deleted by the browser</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Saved chapters and your library live in this browser's storage, which
          it may clear on its own when disk space runs low — without asking, and
          with no way to recover them.{' '}
          {!storage.supported
            ? 'This browser does not support persistent storage, so keep an exported backup instead.'
            : canInstall
              ? 'Installing the app grants persistent storage outright.'
              : 'The browser grants persistent storage on its own once it treats the site as important, so keep an exported backup until then.'}
        </p>
        {storage.outcome && (
          <p className="text-xs leading-relaxed text-destructive">
            {describeOutcome(storage.outcome, canInstall)}
          </p>
        )}
      </div>
    </div>
  )
}
