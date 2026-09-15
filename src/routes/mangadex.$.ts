import { createFileRoute } from '@tanstack/react-router'

import { proxyTo } from '@/server/proxy'

import { mangadexUserAgent } from '@/server/mangadex'

// MangaDex's API. See src/server/mangadex.ts for the User-Agent rule.
const handler = ({ request }: { request: Request }) =>
  proxyTo(request, {
    prefix: '/mangadex',
    target: 'https://api.mangadex.org',
    redirects: 'follow',
    userAgent: mangadexUserAgent(),
  })

export const Route = createFileRoute('/mangadex/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
