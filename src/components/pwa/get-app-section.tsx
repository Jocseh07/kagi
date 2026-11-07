import { useEffect, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  Copy,
  Download,
  Globe,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  TriangleAlert,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { IosInstallDialog } from '@/components/pwa/ios-install-dialog'
import { useInstallOffer } from '@/components/pwa/use-install-offer'
import { formatBytes } from '@/components/download/format'
import {
  describeOutcome,
  useStoragePersistence,
} from '@/components/storage/use-storage-persistence'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { ANDROID_DOWNLOAD_PATH } from '@/lib/app-release'
import type { AppRelease } from '@/lib/app-release'
import { useOnline } from '@/lib/offline/use-online'
import { useAppRelease, useDeviceKind } from '@/lib/pwa/use-app-release'
import type { DeviceKind } from '@/lib/pwa/use-app-release'

const COPIED_MS = 1600

/**
 * The top of Settings → Data: the two ways to keep Kagi, and with them the
 * library, out of the browser's reach. The native Android build is offered
 * once one has been published; the web app is offered wherever the browser can
 * install it. Installing the web app earns persistent storage, so it asks for
 * it again the moment it lands.
 *
 * With nothing to offer it falls back to the plain warning, which is the only
 * thing left to say to a browser that cannot install anything.
 */
export function GetAppSection() {
  const storage = useStoragePersistence()
  const { offer, install, installing } = useInstallOffer(storage.request)
  const kind = useDeviceKind()
  const online = useOnline()
  const release = useAppRelease(kind !== 'ios')
  const [steps, setSteps] = useState(false)

  if (storage.loading) return null

  const canInstall = offer !== 'none'
  const showAndroid =
    kind !== 'ios' && online && !(release.isSuccess && release.data === null)

  const outcome =
    storage.outcome && !storage.persisted
      ? describeOutcome(storage.outcome, canInstall)
      : null

  if (!showAndroid && !canInstall) {
    return storage.persisted ? null : (
      <StorageWarning supported={storage.supported} outcome={outcome} />
    )
  }

  return (
    <section aria-labelledby="get-app-title" className="flex flex-col gap-2">
      <div className="px-1">
        <h2 id="get-app-title" className="text-sm font-medium">
          Get the app
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Either one keeps your saved chapters safe.
        </p>
        {outcome ? <p className="mt-1 text-xs text-destructive">{outcome}</p> : null}
      </div>

      <ul className="@container overflow-hidden rounded-lg border border-border bg-card">
        {showAndroid ? (
          release.isPending ? (
            <AndroidSkeleton />
          ) : release.isError ? (
            <AndroidError onRetry={() => void release.refetch()} />
          ) : release.data ? (
            <AndroidRow release={release.data} kind={kind} />
          ) : null
        ) : null}

        {canInstall ? (
          <Row
            icon={Globe}
            title="Web app"
            hint="Opens from your home screen, no download."
            divided={showAndroid}
          >
            <Button
              variant="secondary"
              className="h-10 shrink-0 md:h-9"
              disabled={installing}
              onClick={() => {
                if (offer === 'instructions') setSteps(true)
                else void install()
              }}
            >
              {installing ? 'Installing' : offer === 'instructions' ? 'Show how' : 'Install'}
            </Button>
          </Row>
        ) : null}
      </ul>

      <IosInstallDialog open={steps} onOpenChange={setSteps} />
    </section>
  )
}

function Row({
  icon: Icon,
  iconClassName = 'bg-muted text-muted-foreground',
  title,
  hint,
  divided = false,
  children,
}: {
  icon: LucideIcon
  iconClassName?: string
  title: string
  hint: React.ReactNode
  divided?: boolean
  children?: React.ReactNode
}) {
  return (
    <li
      className={
        divided
          ? 'flex flex-col gap-3 border-t border-border px-4 py-4 @sm:flex-row @sm:items-center @sm:gap-4'
          : 'flex flex-col gap-3 px-4 py-4 @sm:flex-row @sm:items-center @sm:gap-4'
      }
    >
      <span
        className={`flex size-10 shrink-0 items-center justify-center rounded-full ${iconClassName}`}
      >
        <Icon className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      </div>
      {children}
    </li>
  )
}

function AndroidRow({ release, kind }: { release: AppRelease; kind: DeviceKind }) {
  const [open, setOpen] = useState(false)
  const onPhone = kind === 'android'
  const link = useCopy(() => `${location.origin}${ANDROID_DOWNLOAD_PATH}`)
  const checksum = useCopy(() => release.sha256)

  return (
    <li>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex flex-col gap-3 px-4 py-4 @sm:flex-row @sm:items-center @sm:gap-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Smartphone className="size-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium">Kagi for Android</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Version <span className="tabular-nums">{release.version}</span> ·{' '}
              <span className="tabular-nums">{formatBytes(release.size)}</span> ·{' '}
              {new Date(release.publishedAt).toLocaleDateString(undefined, {
                dateStyle: 'medium',
              })}
            </p>
            {onPhone ? null : (
              <p className="mt-0.5 text-xs text-muted-foreground">
                Open this page on your phone, or copy the link.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2 @sm:flex-row">
            <Button
              asChild
              variant={onPhone ? 'default' : 'secondary'}
              className="h-10 md:h-9"
            >
              <a href={ANDROID_DOWNLOAD_PATH} download onClick={() => setOpen(true)}>
                <Download aria-hidden />
                Download APK
              </a>
            </Button>
            {onPhone ? null : (
              <Button className="h-10 md:h-9" onClick={link.copy}>
                <Copy aria-hidden />
                {link.copied ? 'Copied' : 'Copy link'}
              </Button>
            )}
          </div>
        </div>

        <div className="border-t border-border">
          <CollapsibleTrigger className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-accent/50 focus-visible:outline-2 focus-visible:-outline-offset-2 [&[data-state=open]>svg]:rotate-180">
            <span className="min-w-0 flex-1">How to install</span>
            <ChevronDown
              className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none"
              aria-hidden
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-4 px-4 pb-4">
            <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm marker:text-muted-foreground">
              <li>If you have build 2 or earlier, export your library from Settings, Data.</li>
              <li>For these builds, save the backup outside Kagi, then uninstall.</li>
              <li>Open the downloaded file.</li>
              <li>If Android asks, allow installs from this browser.</li>
              <li>Tap Install, then open Kagi.</li>
            </ol>
            <p className="text-xs text-muted-foreground">
              For 64-bit phones. Restore your library from Settings, Data. Backups
              exclude downloaded chapters and imported files. Download chapters again
              and reimport your original files.
            </p>
            <div className="flex flex-col gap-1.5 rounded-md bg-muted px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">SHA-256</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs text-muted-foreground md:h-7"
                  onClick={checksum.copy}
                >
                  {checksum.copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                  {checksum.copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <code className="block font-mono text-xs leading-relaxed break-all text-muted-foreground">
                {release.sha256}
              </code>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </li>
  )
}

function AndroidSkeleton() {
  return (
    <li aria-hidden className="flex items-center gap-4 px-4 py-4">
      <Skeleton className="size-10 shrink-0 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-3.5 w-36" />
        <Skeleton className="h-3 w-52 max-w-full" />
      </div>
      <Skeleton className="hidden h-9 w-32 @sm:block" />
    </li>
  )
}

function AndroidError({ onRetry }: { onRetry: () => void }) {
  return (
    <Row
      icon={TriangleAlert}
      iconClassName="bg-destructive/10 text-destructive"
      title="Couldn't check for the Android app"
      hint="Check your connection and try again."
    >
      <Button variant="secondary" className="h-10 shrink-0 md:h-9" onClick={onRetry}>
        <RefreshCw aria-hidden />
        Try again
      </Button>
    </Row>
  )
}

/** What is left to say to a browser that can install nothing. */
function StorageWarning({
  supported,
  outcome,
}: {
  supported: boolean
  outcome: string | null
}) {
  return (
    <section
      aria-label="The browser can clear your downloads"
      className="flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-4 sm:flex-row sm:items-center sm:gap-4"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <ShieldAlert className="size-5" aria-hidden />
      </span>

      <div className="min-w-0 flex-1 space-y-0.5">
        <h2 className="text-sm font-medium">The browser can clear your downloads</h2>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {`When space runs low it may delete saved chapters and your library without asking. ${
            supported
              ? 'The browser protects them once it treats the site as important, so keep an exported backup until then.'
              : 'This browser cannot keep them safe, so keep an exported backup.'
          }`}
        </p>
        {outcome ? (
          <p className="text-xs leading-relaxed text-destructive">{outcome}</p>
        ) : null}
      </div>
    </section>
  )
}

function useCopy(read: () => string) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  function copy() {
    void navigator.clipboard?.writeText(read()).then(
      () => {
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), COPIED_MS)
      },
      () => {},
    )
  }

  return { copied, copy }
}
