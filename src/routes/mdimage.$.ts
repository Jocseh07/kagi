import { createFileRoute } from '@tanstack/react-router'

import { proxyTo } from '@/server/proxy'

import { mangadexUserAgent } from '@/server/mangadex'

// Page images. The host is assigned per chapter by `/at-home/server`, so the
// source puts it in the path and the pattern keeps this to MangaDex@Home.
const handler = ({ request }: { request: Request }) =>
  proxyTo(request, {
    prefix: '/mdimage',
    target: 'https://mangadex.network',
    hostPattern: /^[a-z0-9-]+\.mangadex\.network$/,
    redirects: 'follow',
    userAgent: mangadexUserAgent(),
  })

export const Route = createFileRoute('/mdimage/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
