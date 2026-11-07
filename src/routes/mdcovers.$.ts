import { sourceProxyPolicies } from '@/lib/transport/source-policy'
import { createFileRoute } from '@tanstack/react-router'
import * as Effect from 'effect/Effect'

import { runServer } from '@/server/effect/run'
import { mangadexUserAgent } from '@/server/mangadex'
import { proxyTo } from '@/server/proxy'

// Cover art. MangaDex serves the wrong bytes to hotlinked images, so covers
// go through here like everything else of theirs.
const handler = async ({ request }: { request: Request }) =>
  await runServer(
    Effect.flatMap(mangadexUserAgent, (userAgent) =>
      proxyTo(request, {...sourceProxyPolicies['/mdcovers'], userAgent}),
    ),
  )

export const Route = createFileRoute('/mdcovers/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
