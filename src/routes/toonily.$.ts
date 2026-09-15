import { createFileRoute } from '@tanstack/react-router'

import { proxyTo } from '@/server/proxy'

// Toonily hides mature series until the age cookie is set; the extension
// sets the same one.
const handler = ({ request }: { request: Request }) =>
  proxyTo(request, {
    prefix: '/toonily',
    target: 'https://toonily.com',
    redirects: 'manual',
    browserHeaders: true,
    cookies: { 'toonily-mature': '1' },
  })

export const Route = createFileRoute('/toonily/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
