import { sourceProxyPolicies } from '@/lib/transport/source-policy'
import { createFileRoute } from '@tanstack/react-router'

import { runServer } from '@/server/effect/run'
import { proxyTo } from '@/server/proxy'

// Fenrir Realm's API sends no CORS headers, so the browser build reaches it
// through here. `browserHeaders: true` is not decoration: the API answers 403
// to a request carrying no User-Agent at all, which is what a bare Worker
// fetch sends. `redirects: 'follow'` matters for chapter links — the site
// answers a chapter addressed by id with a 303 to its canonical slug path.
const handler = async ({ request }: { request: Request }) =>
  await runServer(
    proxyTo(request, sourceProxyPolicies['/fenrirealm']),
  )

export const Route = createFileRoute('/fenrirealm/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
