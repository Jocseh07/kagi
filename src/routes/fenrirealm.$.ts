import { createFileRoute } from '@tanstack/react-router'

import { proxyTo } from '@/server/proxy'

// Fenrir Realm's API sends no CORS headers, so the browser build reaches it
// through here. `browserHeaders: true` is not decoration: the API answers 403
// to a request carrying no User-Agent at all, which is what a bare Worker
// fetch sends. `redirects: 'follow'` matters for chapter links — the site
// answers a chapter addressed by id with a 303 to its canonical slug path.
const handler = ({ request }: { request: Request }) =>
  proxyTo(request, {
    prefix: '/fenrirealm',
    target: 'https://fenrirealm.com',
    redirects: 'follow',
    browserHeaders: true,
  })

export const Route = createFileRoute('/fenrirealm/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
