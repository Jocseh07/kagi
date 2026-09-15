import { createFileRoute } from '@tanstack/react-router'

import { proxyTo } from '@/server/proxy'

// Comick's image hosts answer 403 to a request with no Referer, and the
// browser never sends one through the reader. Numbered hosts, hence the
// pattern.
const handler = ({ request }: { request: Request }) =>
  proxyTo(request, {
    prefix: '/comickcdn',
    target: 'https://meo.comick.pictures',
    hostPattern: /^[a-z0-9]+\.comick(new)?\.pictures$/,
    redirects: 'follow',
    referer: 'https://comick.live/',
  })

export const Route = createFileRoute('/comickcdn/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
