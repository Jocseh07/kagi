import { sourceProxyPolicies } from '@/lib/transport/source-policy'
import { createFileRoute } from '@tanstack/react-router'

import { runServer } from '@/server/effect/run'
import { proxyTo } from '@/server/proxy'

// NovelPing sends no CORS headers on any page, so the browser build reaches the
// listings, series pages, chapter bodies and the ajax chapter list through here.
// No `assets: true`: this prefix serves HTML that changes. Covers are not
// proxied at all — `images.novelping.com` is loaded straight by `<img>`, which
// needs neither CORS nor a `Referer`.
const handler = async ({ request }: { request: Request }) =>
  await runServer(
    proxyTo(request, sourceProxyPolicies['/novelping']),
  )

export const Route = createFileRoute('/novelping/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
