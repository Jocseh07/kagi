import { sourceProxyPolicies } from '@/lib/transport/source-policy'
import { createFileRoute } from '@tanstack/react-router'

import { runServer } from '@/server/effect/run'
import { proxyTo } from '@/server/proxy'

/**
 * MANGA Plus's protobuf API.
 *
 * Without a session token it answers every call with an "Account Banned"
 * popup instead of data, so one is minted the way the extension mints one per
 * install — a random id, reused for the life of the isolate.
 *
 * Minted on the first request rather than at module scope: a Worker forbids
 * generating random values while the global scope is still evaluating.
 */
let session: string | null = null

function sessionToken(): string {
  session ??= crypto.randomUUID()
  return session
}

const handler = async ({ request }: { request: Request }) =>
  await runServer(
    proxyTo(request, {...sourceProxyPolicies['/mangaplus'], headers: {'SESSION-TOKEN': sessionToken()}}),
  )

export const Route = createFileRoute('/mangaplus/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
