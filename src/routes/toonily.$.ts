import { sourceProxyPolicies } from '@/lib/transport/source-policy'
import { createFileRoute } from '@tanstack/react-router'

import { runServer } from '@/server/effect/run'
import { proxyTo } from '@/server/proxy'

// Toonily hides mature series until the age cookie is set; the extension
// sets the same one.
const handler = async ({ request }: { request: Request }) =>
  await runServer(
    proxyTo(request, sourceProxyPolicies['/toonily']),
  )

export const Route = createFileRoute('/toonily/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
