import { sourceProxyPolicies } from '@/lib/transport/source-policy'
import { createFileRoute } from '@tanstack/react-router'

import { runServer } from '@/server/effect/run'
import { proxyTo } from '@/server/proxy'

// Comick's image hosts answer 403 to a request with no Referer, and the
// browser never sends one through the reader. Numbered hosts, hence the
// pattern.
const handler = async ({ request }: { request: Request }) =>
  await runServer(
    proxyTo(request, sourceProxyPolicies['/comickcdn']),
  )

export const Route = createFileRoute('/comickcdn/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
