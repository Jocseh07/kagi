import { sourceProxyPolicies } from '@/lib/transport/source-policy'
import { createFileRoute } from '@tanstack/react-router'
import * as Effect from 'effect/Effect'

import { runServer } from '@/server/effect/run'
import { mangadexUserAgent } from '@/server/mangadex'
import { proxyTo } from '@/server/proxy'

// Page images. The host is assigned per chapter by `/at-home/server`, so the
// source puts it in the path and the pattern keeps this to MangaDex@Home.
const handler = async ({ request }: { request: Request }) =>
  await runServer(
    Effect.flatMap(mangadexUserAgent, (userAgent) =>
      proxyTo(request, {...sourceProxyPolicies['/mdimage'], userAgent}),
    ),
  )

export const Route = createFileRoute('/mdimage/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
