import { createFileRoute } from '@tanstack/react-router'

import { proxyTo } from '@/server/proxy'

// Webtoons gates mature series and consent behind cookies; these are the
// three the extension sets. Redirects are followed because a listing URL
// canonicalises through one.
const handler = ({ request }: { request: Request }) =>
  proxyTo(request, {
    prefix: '/webtoons',
    target: 'https://www.webtoons.com',
    redirects: 'follow',
    browserHeaders: true,
    cookies: { ageGatePass: 'true', locale: 'en', needGDPR: 'false' },
  })

export const Route = createFileRoute('/webtoons/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
