import { sourceProxyPolicies } from '@/lib/transport/source-policy'
import { createFileRoute } from '@tanstack/react-router'
import * as Effect from 'effect/Effect'

import { runServer } from '@/server/effect/run'
import { mangadexUserAgent } from '@/server/mangadex'
import { proxyTo } from '@/server/proxy'

// MangaDex's API. See src/server/mangadex.ts for the User-Agent rule.
const handler = async ({ request }: { request: Request }) =>
  await runServer(
    Effect.flatMap(mangadexUserAgent, (userAgent) =>
      proxyTo(request, {...sourceProxyPolicies['/mangadex'], userAgent}),
    ),
  )

export const Route = createFileRoute('/mangadex/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
