import { createFileRoute } from '@tanstack/react-router'

import { proxyTo } from '@/server/proxy'

// Asura's API does send CORS, but only by reflecting the request's `Origin`,
// and it is the smaller half of the problem: its image CDN sends none at all
// (see asuracdn.$.ts). Routing the API through here too keeps the source on one
// transport rather than half-proxied, and lets the browser open a single
// connection instead of one per Asura host.
//
// `redirects: 'manual'` matches the other proxies. The API answers no
// redirects today; passing them back rewritten costs nothing and means a future
// one does not silently escape the proxy and fail the CORS check.
const handler = ({ request }: { request: Request }) =>
  proxyTo(request, {
    prefix: '/asurascans',
    target: 'https://api.asurascans.com',
    redirects: 'manual',
  })

export const Route = createFileRoute('/asurascans/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
