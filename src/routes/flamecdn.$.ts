import { createFileRoute } from '@tanstack/react-router'

import { proxyTo } from '@/server/proxy'

// Flame Comics' image CDN. No CORS headers.
const handler = ({ request }: { request: Request }) =>
  proxyTo(request, {
    prefix: '/flamecdn',
    target: 'https://cdn.flamecomics.xyz',
    redirects: 'follow',
  })

export const Route = createFileRoute('/flamecdn/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
