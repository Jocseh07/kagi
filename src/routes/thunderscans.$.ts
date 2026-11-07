import { sourceProxyPolicies } from '@/lib/transport/source-policy'
import { createFileRoute } from '@tanstack/react-router'

import { runServer } from '@/server/effect/run'
import { proxyTo } from '@/server/proxy'

// Thunder Scans withholds CORS on its HTML and its page images, which share
// one origin — this hop makes the bytes readable too. Redirects matter here:
// asking for a series by its stable slug is answered with a 301 to the
// rotating one, and those `Location` headers are absolute URLs on the site's
// own origin. `redirects: 'manual'` hands them to the browser with the
// Location rewritten back under `/thunderscans`, which is why the source needs
// no slug cache.
const handler = async ({ request }: { request: Request }) =>
  await runServer(
    proxyTo(request, sourceProxyPolicies['/thunderscans']),
  )

export const Route = createFileRoute('/thunderscans/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
