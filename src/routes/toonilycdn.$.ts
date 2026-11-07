import { sourceProxyPolicies } from '@/lib/transport/source-policy'
import { createFileRoute } from '@tanstack/react-router'

import { runServer } from '@/server/effect/run'
import { proxyTo } from '@/server/proxy'

// Toonily's page images (`data`) and covers (`static`). Pages answer 403
// without a Referer.
const handler = async ({ request }: { request: Request }) =>
  await runServer(
    proxyTo(request, sourceProxyPolicies['/toonilycdn']),
  )

export const Route = createFileRoute('/toonilycdn/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
