import { createFileRoute } from '@tanstack/react-router'

import { proxyTo } from '@/server/proxy'

// Asura's covers and page images live on `cdn.asurascans.com`, which sends no
// `Access-Control-Allow-Origin` on anything — not even to a request that
// carries an `Origin` header, unlike the API. Read directly, every page arrives
// opaque: unreadable bytes that cannot be packed into a CBZ and that the
// browser charges ~7 MB of quota against regardless of what they really weigh.
// This hop makes them same-origin, and therefore readable, exportable, and
// counted at their real size.
//
// A separate prefix from `/asurascans` because `proxyTo` maps one prefix to one
// origin, and these are two hosts.
const handler = ({ request }: { request: Request }) =>
  proxyTo(request, {
    prefix: '/asuracdn',
    target: 'https://cdn.asurascans.com',
    redirects: 'manual',
  })

export const Route = createFileRoute('/asuracdn/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
