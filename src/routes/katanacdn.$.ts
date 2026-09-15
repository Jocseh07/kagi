import { createFileRoute } from '@tanstack/react-router'

import { proxyTo } from '@/server/proxy'

// MangaKatana's numbered image hosts.
const handler = ({ request }: { request: Request }) =>
  proxyTo(request, {
    prefix: '/katanacdn',
    target: 'https://i1.mangakatana.com',
    hostPattern: /^i[0-9]*\.mangakatana\.com$/,
    redirects: 'follow',
  })

export const Route = createFileRoute('/katanacdn/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
