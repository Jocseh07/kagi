import { createFileRoute } from '@tanstack/react-router'

import { proxyTo } from '@/server/proxy'

// MangaKatana sends no CORS headers. No bot defence today.
const handler = ({ request }: { request: Request }) =>
  proxyTo(request, {
    prefix: '/mangakatana',
    target: 'https://mangakatana.com',
    redirects: 'manual',
    browserHeaders: true,
  })

export const Route = createFileRoute('/mangakatana/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
