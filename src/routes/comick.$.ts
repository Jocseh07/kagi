import { sourceProxyPolicies } from '@/lib/transport/source-policy'
import { createFileRoute } from '@tanstack/react-router'

import { runServer } from '@/server/effect/run'
import { proxyTo } from '@/server/proxy'

// Comick's JSON API and its chapter pages. Search sits behind a bot check
// for scripted clients; the challenge detector surfaces that as such.
const handler = async ({ request }: { request: Request }) =>
  await runServer(
    proxyTo(request, sourceProxyPolicies['/comick']),
  )

export const Route = createFileRoute('/comick/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
