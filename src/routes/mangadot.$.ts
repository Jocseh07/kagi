import { sourceProxyPolicies } from '@/lib/transport/source-policy'
import { createFileRoute } from '@tanstack/react-router'

import { runServer } from '@/server/effect/run'
import { proxyTo } from '@/server/proxy'

// Mangadot sends no CORS headers on its API or its images; borrowing this
// origin is what makes the source work at all. No bot defence, so a plain hop
// with redirects passed through (and contained on-origin) is enough.
const handler = async ({ request }: { request: Request }) =>
  await runServer(
    proxyTo(request, sourceProxyPolicies['/mangadot']),
  )

export const Route = createFileRoute('/mangadot/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
