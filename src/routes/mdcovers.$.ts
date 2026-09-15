import { createFileRoute } from '@tanstack/react-router'

import { proxyTo } from '@/server/proxy'

import { mangadexUserAgent } from '@/server/mangadex'

// Cover art. MangaDex serves the wrong bytes to hotlinked images, so covers
// go through here like everything else of theirs.
const handler = ({ request }: { request: Request }) =>
  proxyTo(request, {
    prefix: '/mdcovers',
    target: 'https://uploads.mangadex.org',
    redirects: 'follow',
    userAgent: mangadexUserAgent(),
  })

export const Route = createFileRoute('/mdcovers/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
