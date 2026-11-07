import { sourceProxyPolicies } from '@/lib/transport/source-policy'
import { createFileRoute } from '@tanstack/react-router'

import { runServer } from '@/server/effect/run'
import { proxyTo } from '@/server/proxy'

// Flame Comics' image CDN. No CORS headers.
const handler = async ({ request }: { request: Request }) =>
  await runServer(
    proxyTo(request, sourceProxyPolicies['/flamecdn']),
  )

export const Route = createFileRoute('/flamecdn/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
