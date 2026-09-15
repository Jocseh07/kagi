/**
 * The router factory Start calls, on the client and during the shell
 * prerender.
 *
 * A factory rather than a module-level singleton because Start builds one
 * router per request on the server; the query client is created alongside it
 * for the same reason, so that a prerender cannot leak cached data into the
 * shipped shell.
 *
 * There is no per-route SSR setting here: the app is client-only by
 * construction — SQLite-WASM over OPFS, a service worker, a theme read from
 * localStorage before the first paint — and `spa: { enabled: true }` on the
 * Start plugin in vite.config.ts already means nothing below the root is
 * rendered on the server.
 */

import { createRouter } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'

import { NotFoundScreen, RouteErrorScreen } from '@/components/ui/error-screen'
import { LoadingScreen } from '@/components/ui/loading-screen'

import { routeTree } from './routeTree.gen'

export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Source responses are cheap to refetch but rate-limited; prefer cache.
        staleTime: 5 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
        // Nearly every query here reads the local SQLite database, which is as
        // available offline as it is online. React Query's default 'online'
        // mode pauses *all* of them the moment the browser goes offline — the
        // query function is never called and never errors — so a device with
        // no connection sits on skeletons instead of showing the library it
        // already holds. Source-backed queries fail fast instead, which the UI
        // reports as being offline.
        networkMode: 'always',
      },
      mutations: {
        // Same reason: a favourite or a mark-read is a local write, and
        // pausing it until the network returns loses the action entirely.
        networkMode: 'always',
      },
    },
  })

  const router = createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    // React Query owns freshness here; routes fetch in components rather than
    // in loaders. Without this the router would keep its own 30s preload cache
    // over the same work, under different rules.
    defaultPreloadStaleTime: 0,
    // What the shell renders in place of the matched route. In SPA mode this
    // is the only thing prerendered below the root, so it must be cheap and
    // must not touch the database — a spinner centred in the content area,
    // with the header and navigation above it left standing.
    defaultPendingComponent: () => <LoadingScreen />,
    // A wait has to last this long before the pending component is shown at
    // all, and once shown it stays at least `MinMs`. Together they stop a
    // transition that resolves quickly from flashing a spinner on its way past.
    defaultPendingMs: 200,
    defaultPendingMinMs: 300,
    // Without these two the router falls back to its own unstyled error box
    // and a bare "Not Found" string, neither of which follows the theme.
    defaultErrorComponent: RouteErrorScreen,
    defaultNotFoundComponent: NotFoundScreen,
  })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
