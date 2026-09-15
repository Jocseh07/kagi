import { createFileRoute } from '@tanstack/react-router'

import { proxyTo } from '@/server/proxy'

// Mangadot sends no CORS headers on its API or its images; borrowing this
// origin is what makes the source work at all. No bot defence, so a plain hop
// with redirects passed through (and contained on-origin) is enough.
const handler = ({ request }: { request: Request }) =>
  proxyTo(request, {
    prefix: '/mangadot',
    target: 'https://mangadot.net',
    redirects: 'manual',
  })

export const Route = createFileRoute('/mangadot/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
