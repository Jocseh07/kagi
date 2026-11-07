import { sourceProxyPolicies } from '@/lib/transport/source-policy'
import { createFileRoute } from '@tanstack/react-router'

import { runServer } from '@/server/effect/run'
import { proxyTo } from '@/server/proxy'

// Weeb Central sends no CORS headers on its HTML. No bot defence today, so a
// plain hop is enough.
const handler = async ({ request }: { request: Request }) =>
  await runServer(
    proxyTo(request, sourceProxyPolicies['/weebcentral']),
  )

export const Route = createFileRoute('/weebcentral/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
