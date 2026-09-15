import { createFileRoute } from '@tanstack/react-router'

import { proxyTo } from '@/server/proxy'

// Webtoons' image hosts answer 403 without a Referer from the site.
const handler = ({ request }: { request: Request }) =>
  proxyTo(request, {
    prefix: '/webtoonscdn',
    target: 'https://webtoon-phinf.pstatic.net',
    hostPattern: /^[a-z-]+\.pstatic\.net$/,
    redirects: 'follow',
    referer: 'https://www.webtoons.com/',
  })

export const Route = createFileRoute('/webtoonscdn/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
