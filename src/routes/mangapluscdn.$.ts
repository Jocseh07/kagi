import { sourceProxyPolicies } from '@/lib/transport/source-policy'
import { createFileRoute } from '@tanstack/react-router'

import { runServer } from '@/server/effect/run'
import { proxyTo } from '@/server/proxy'

// MANGA Plus page images. Each needs the viewer token from the chapter call
// as a header and arrives XOR-encrypted with a per-page key; both travel as
// query parameters because an <img> can carry nothing else.
const handler = async ({ request }: { request: Request }) =>
  await runServer(
    proxyTo(request, sourceProxyPolicies['/mangapluscdn']),
  )

export const Route = createFileRoute('/mangapluscdn/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
