import { createFileRoute } from '@tanstack/react-router'

import { proxyTo } from '@/server/proxy'

// NovelMTL sends no CORS headers on either its JSON API or its rendered pages,
// so the browser build reaches both through here. `browserHeaders: true`
// because the site sits behind Cloudflare, which is the same reason NovelFull's
// route sets it. `redirects: 'follow'` covers the site's own canonicalisation —
// `novelmtl.com` 302s to `novelmtl.app`, and its edge cache has been seen
// holding a stale 302 for a reader path.
const handler = ({ request }: { request: Request }) =>
  proxyTo(request, {
    prefix: '/novelmtl',
    target: 'https://novelmtl.app',
    redirects: 'follow',
    browserHeaders: true,
  })

export const Route = createFileRoute('/novelmtl/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
