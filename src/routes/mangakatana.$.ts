import { sourceProxyPolicies } from '@/lib/transport/source-policy'
import { createFileRoute } from '@tanstack/react-router'

import { runServer } from '@/server/effect/run'
import { proxyTo } from '@/server/proxy'

// MangaKatana sends no CORS headers. No bot defence today.
const handler = async ({ request }: { request: Request }) =>
  await runServer(
    proxyTo(request, sourceProxyPolicies['/mangakatana']),
  )

export const Route = createFileRoute('/mangakatana/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
