import { sourceProxyPolicies } from '@/lib/transport/source-policy'
import { createFileRoute } from '@tanstack/react-router'

import { runServer } from '@/server/effect/run'
import { proxyTo } from '@/server/proxy'

// MangaKatana's numbered image hosts.
const handler = async ({ request }: { request: Request }) =>
  await runServer(
    proxyTo(request, sourceProxyPolicies['/katanacdn']),
  )

export const Route = createFileRoute('/katanacdn/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
