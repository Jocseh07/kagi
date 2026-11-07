import { sourceProxyPolicies } from '@/lib/transport/source-policy'
import { createFileRoute } from '@tanstack/react-router'

import { runServer } from '@/server/effect/run'
import { proxyTo } from '@/server/proxy'

// Webtoons' image hosts answer 403 without a Referer from the site.
const handler = async ({ request }: { request: Request }) =>
  await runServer(
    proxyTo(request, sourceProxyPolicies['/webtoonscdn']),
  )

export const Route = createFileRoute('/webtoonscdn/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
