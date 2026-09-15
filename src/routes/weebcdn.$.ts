import { createFileRoute } from '@tanstack/react-router'

import { proxyTo } from '@/server/proxy'

// Weeb Central's cover and page image host. It serves without a Referer but
// sends no CORS headers, so images read directly would arrive opaque.
const handler = ({ request }: { request: Request }) =>
  proxyTo(request, {
    prefix: '/weebcdn',
    target: 'https://temp.compsci88.com',
    redirects: 'follow',
  })

export const Route = createFileRoute('/weebcdn/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
