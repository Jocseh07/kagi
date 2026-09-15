import { createFileRoute } from '@tanstack/react-router'

import { proxyTo } from '@/server/proxy'

// MANGA Plus page images. Each needs the viewer token from the chapter call
// as a header and arrives XOR-encrypted with a per-page key; both travel as
// query parameters because an <img> can carry nothing else.
const handler = ({ request }: { request: Request }) =>
  proxyTo(request, {
    prefix: '/mangapluscdn',
    target: 'https://mangaplus.shueisha.co.jp',
    hostPattern: /^[a-z0-9-]+\.tokyo-cdn\.com$/,
    redirects: 'follow',
    headerParams: { vw: 'Plus-Vw-Token' },
    xorKeyParam: 'key',
  })

export const Route = createFileRoute('/mangapluscdn/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
