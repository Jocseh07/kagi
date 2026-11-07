import { sourceProxyPolicies } from '@/lib/transport/source-policy'
import { createFileRoute } from '@tanstack/react-router'

import { runServer } from '@/server/effect/run'
import { proxyTo } from '@/server/proxy'

// Webtoons gates mature series and consent behind cookies; these are the
// three the extension sets. Redirects are followed because a listing URL
// canonicalises through one.
const handler = async ({ request }: { request: Request }) =>
  await runServer(
    proxyTo(request, sourceProxyPolicies['/webtoons']),
  )

export const Route = createFileRoute('/webtoons/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
