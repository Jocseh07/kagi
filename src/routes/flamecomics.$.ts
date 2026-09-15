import { createFileRoute } from '@tanstack/react-router'

import { proxyTo } from '@/server/proxy'

// Flame Comics is a Next.js site; the source reads its `/_next/data` JSON.
// A stale build id is answered with an HTML 404 the source has to parse for
// the new id, which is why the full browser header set is sent.
const handler = ({ request }: { request: Request }) =>
  proxyTo(request, {
    prefix: '/flamecomics',
    target: 'https://flamecomics.xyz',
    redirects: 'manual',
    browserHeaders: true,
  })

export const Route = createFileRoute('/flamecomics/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
