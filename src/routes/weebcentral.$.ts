import { createFileRoute } from '@tanstack/react-router'

import { proxyTo } from '@/server/proxy'

// Weeb Central sends no CORS headers on its HTML. No bot defence today, so a
// plain hop is enough.
const handler = ({ request }: { request: Request }) =>
  proxyTo(request, {
    prefix: '/weebcentral',
    target: 'https://weebcentral.com',
    redirects: 'manual',
  })

export const Route = createFileRoute('/weebcentral/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
