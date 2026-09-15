import { createFileRoute } from '@tanstack/react-router'

import { proxyTo } from '@/server/proxy'

// Toonily's page images (`data`) and covers (`static`). Pages answer 403
// without a Referer.
const handler = ({ request }: { request: Request }) =>
  proxyTo(request, {
    prefix: '/toonilycdn',
    target: 'https://data.tnlycdn.com',
    hostPattern: /^(data|static)\.tnlycdn\.com$/,
    redirects: 'follow',
    referer: 'https://toonily.com/',
  })

export const Route = createFileRoute('/toonilycdn/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
