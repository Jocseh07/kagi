import { sourceProxyPolicies } from '@/lib/transport/source-policy'
import { createFileRoute } from '@tanstack/react-router'

import { runServer } from '@/server/effect/run'
import { proxyTo } from '@/server/proxy'

// Weeb Central's cover and page image host. It serves without a Referer but
// sends no CORS headers, so images read directly would arrive opaque.
const handler = async ({ request }: { request: Request }) =>
  await runServer(
    proxyTo(request, sourceProxyPolicies['/weebcdn']),
  )

export const Route = createFileRoute('/weebcdn/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
