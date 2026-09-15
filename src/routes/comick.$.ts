import { createFileRoute } from '@tanstack/react-router'

import { proxyTo } from '@/server/proxy'

// Comick's JSON API and its chapter pages. Search sits behind a bot check
// for scripted clients; the challenge detector surfaces that as such.
const handler = ({ request }: { request: Request }) =>
  proxyTo(request, {
    prefix: '/comick',
    target: 'https://comick.live',
    redirects: 'manual',
    browserHeaders: true,
    referer: 'https://comick.live/',
  })

export const Route = createFileRoute('/comick/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
