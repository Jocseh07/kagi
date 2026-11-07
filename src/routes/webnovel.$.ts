import { sourceProxyPolicies } from '@/lib/transport/source-policy'
import { createFileRoute } from '@tanstack/react-router'

import { runServer } from '@/server/effect/run'
import { proxyTo } from '@/server/proxy'

// Webnovel sends no CORS headers on its pages, so the browser build reaches
// them through here. `browserHeaders: true` because the site is Cloudflare
// -fronted and a bare Worker fetch carries no User-Agent at all. If Cloudflare
// challenges the Worker's fingerprint, proxyTo answers 503 with
// `x-proxy-challenge` and the app degrades to its explicit challenge error.
// `redirects: 'follow'` covers the slug forms of the book paths, which 301 to
// their numeric equivalents.
const handler = async ({ request }: { request: Request }) =>
  await runServer(
    proxyTo(request, sourceProxyPolicies['/webnovel']),
  )

export const Route = createFileRoute('/webnovel/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
