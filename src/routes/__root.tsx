import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
  useRouterState,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { ClerkProvider, useUser } from '@clerk/react'

import { AppBottomNav } from '@/components/app-bottom-nav'
import { AppHeader } from '@/components/app-header'
import { IncognitoBanner } from '@/components/incognito-banner'
import { InstallBanner } from '@/components/pwa/install-banner'
import { NavigationProgress } from '@/components/navigation-progress'
import { OfflineBanner } from '@/components/offline-banner'
import { PageBackProvider } from '@/components/page-back'
import { Toaster } from '@/components/ui/sonner'
import { useQueueRuntime } from '@/components/download/use-queue-runtime'
import { DatabaseProvider } from '@/lib/db/provider'
import { useDatabaseReady } from '@/lib/db/provider'
import { dbKeys } from '@/lib/db/query-keys'
import { getQueueSummary } from '@/lib/download/queue-repository'
import { setAccountResolved, setAccountUser } from '@/lib/profile/identity'
import { markOnboarded } from '@/lib/profile/store'
import { UpdatePrompt } from '@/lib/offline/update-prompt'
import { accountsEnabled, clerkPublishableKey } from '@/lib/sync/config'
import { useSyncOnEvents } from '@/lib/sync/sync-events'
import { useSyncOnSignIn } from '@/lib/sync/use-sync'
import { ScrollElementProvider } from '@/lib/virtual/scroll-context'

import appCss from '@/index.css?url'
import { themeBootScript } from '@/lib/theme/boot-script'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      // `viewport-fit=cover` lets the page reach under a notch and under the
      // status bar, which is what the reader wants: iOS grants no element full
      // screen, so drawing behind the indicators is as close as it gets. Every
      // bar that would otherwise land there pads itself by the safe area.
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1.0, viewport-fit=cover',
      },
      // Home-screen iOS only. Together these draw the status bar over the page
      // instead of on a band of its own, so a dark chapter reads as full
      // bleed rather than as a page under a grey strip.
      { name: 'apple-mobile-web-app-capable', content: 'yes' },
      { name: 'mobile-web-app-capable', content: 'yes' },
      {
        name: 'apple-mobile-web-app-status-bar-style',
        content: 'black-translucent',
      },
      // The default dark background, oklch(0.145 0 0). Rewritten by the boot
      // script below, and by lib/theme/apply, to match the chosen theme.
      { name: 'theme-color', content: '#0a0a0a' },
      { title: 'Kagi' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      // iOS before 16.4 reads no manifest, and without this it uses a
      // screenshot of the page as the home screen icon. The 192 is scaled
      // rather than a 180 of its own: it is already opaque with the glyph
      // inset, so iOS's corner mask has nothing to cut into.
      { rel: 'apple-touch-icon', href: '/icon-192.png' },
      { rel: 'manifest', href: '/manifest.webmanifest' },
      // No source origin is preconnected. Every source is now reached through
      // a same-origin hop (see the proxy routes), whose connection is the one
      // the document already opened; the upstream handshakes happen on the
      // Worker, where a hint from here cannot reach. Asura used to be the
      // exception and is not any more — its image CDN sends no CORS headers,
      // so it went behind a proxy too.
    ],
  }),
  shellComponent: RootDocument,
  component: RootLayout,
})

/**
 * The document itself — what `index.html` used to be.
 *
 * This is the only part of the app that Start prerenders, into the SPA shell;
 * everything below `Outlet` renders on the client. The providers live here
 * rather than in an entry file so that they wrap the shell too.
 */
function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        {/* Blocking on purpose: the mode class and the chosen theme's
            variables both have to be in place before the first paint, or the
            default palette flashes underneath whatever was actually picked. */}
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>
        <QueryClientProvider client={Route.useRouteContext().queryClient}>
          {/* Inside the query provider and outside the database one: sync
              reads the session and writes through React Query's caches, but
              must not delay the local database opening. */}
          <Providers>
            <DatabaseProvider>{children}</DatabaseProvider>
          </Providers>
        </QueryClientProvider>
        <UpdatePrompt />
        <Scripts />
      </body>
    </html>
  )
}

/**
 * No Clerk key means no account system: the tree renders unwrapped and every
 * sign-in affordance is left out. See lib/sync/config.ts.
 */
function Providers({ children }: { children: ReactNode }) {
  if (!clerkPublishableKey) return children
  return (
    <ClerkProvider publishableKey={clerkPublishableKey} afterSignOutUrl="/">
      {children}
    </ClerkProvider>
  )
}

function RootLayout() {
  // State rather than a ref: the lists below need to re-render once the
  // scroller exists, and a ref attaching during commit tells them nothing.
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null)

  // The welcome runs before there is a profile to hang the account menu on, and
  // before the user has chosen anything the nav leads to.
  const onWelcome = useRouterState({
    select: (state) => state.location.pathname === '/welcome',
  })

  return (
    <div className="flex h-full flex-col">
      <NavigationProgress />
      <DownloadRuntime />
      {accountsEnabled ? <IdentityBridge /> : null}
      {accountsEnabled ? <SyncRuntime /> : null}

      {/* Both sides of the back target live under one provider: the header
          reads what the routed page below publishes. */}
      <PageBackProvider>
        {onWelcome ? null : <AppHeader />}
        {onWelcome ? null : <OfflineBanner />}
        {onWelcome ? null : <IncognitoBanner />}
        {/* Last of the three: offline and incognito are states to act on now,
            installing is an offer that can wait. */}
        {onWelcome ? null : <InstallBanner />}

        <main ref={setScrollElement} className="min-h-0 flex-1 overflow-y-auto">
          <ScrollElementProvider value={scrollElement}>
            <Outlet />
          </ScrollElementProvider>
        </main>

        {/* Below `md` only; a row of its own under the scroller, so no page has
            to reserve space for it. */}
        {onWelcome ? null : <AppBottomNav />}
      </PageBackProvider>

      {/* Outside the nav provider and last in the tree: a toast belongs to the
          app, not to whichever page raised it, and it must draw over both
          bars. */}
      <Toaster />
    </div>
  )
}

/**
 * Mirrors the signed-in Clerk user into the identity store, and renders
 * nothing.
 *
 * The header and the profile panel resolve "account or local profile" from
 * that store instead of from Clerk hooks, because they must also render on
 * keyless builds where there is no `ClerkProvider` to hook into. Rendered only
 * when a Clerk key is configured, because `useUser` throws without that
 * provider. Depends on the extracted fields rather than the `user` object —
 * Clerk hands back fresh objects across renders, and the store only needs to
 * hear about actual changes.
 */
function IdentityBridge() {
  const { user, isLoaded } = useUser()

  // Published separately from the user, because "no user" and "no answer yet"
  // are the same value and only this flag tells them apart. The welcome waits
  // on it rather than painting the signed-out answer and correcting itself.
  useEffect(() => {
    setAccountResolved(isLoaded)
  }, [isLoaded])

  const id = user?.id
  const name =
    user?.fullName ?? user?.username ?? user?.primaryEmailAddress?.emailAddress ?? 'Signed in'
  const email = user?.primaryEmailAddress?.emailAddress ?? ''
  const imageUrl = user?.imageUrl ?? ''

  useEffect(() => {
    setAccountUser(id ? { id, name, email, imageUrl } : null)
    // A signed-in user never needs the welcome — the account is the identity.
    // Recording that here lets the synchronous route guards (which cannot see
    // Clerk's async session) send them straight into the app on later visits.
    if (id) markOnboarded()
  }, [id, name, email, imageUrl])

  return null
}

/**
 * Runs one sync when a session signs in and one on each sync event (finishing
 * a chapter, leaving the reader, the app coming back into view, the
 * connection returning), and renders nothing.
 *
 * App-wide rather than on a page, because the point is the arrival: a fresh
 * device lands on the library, and the library is what the run fills. Its own
 * component for the same reason `DownloadRuntime` is — the run publishes state
 * as it goes, and subscribing from the layout would re-render the header and
 * the whole routed page with it. Rendered only when a Clerk key is configured;
 * `useAuth` throws without the provider.
 */
function SyncRuntime() {
  useSyncOnSignIn()
  useSyncOnEvents()
  return null
}

/**
 * Mounted app-wide so a queue left pending from a previous session resumes on
 * load, rather than only when the user happens to open /downloads.
 *
 * Its own component, and rendering nothing, on purpose: the runtime publishes a
 * fresh state object about once a second per download in flight, so subscribing
 * from the layout would re-render the header and the whole routed page on every
 * tick. Here the tick re-renders this and nothing else.
 */
function DownloadRuntime() {
  const ready = useDatabaseReady()

  // Rows left waiting by an earlier session: without this count the hook sees a
  // stopped runtime with nothing known to do and never nudges it, so a reload
  // would leave the queue sitting idle. `paused` is left out deliberately —
  // a pause the user asked for should survive a reload.
  const summary = useQuery({
    queryKey: dbKeys.queueSummary,
    queryFn: getQueueSummary,
    enabled: ready,
  })
  const counts = summary.data?.counts
  const waiting = (counts?.queued ?? 0) + (counts?.active ?? 0)

  useQueueRuntime(waiting)
  return null
}
