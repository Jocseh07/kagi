import { createFileRoute } from '@tanstack/react-router'

import { proxyTo } from '@/server/proxy'

// NovelFull is the fingerprinted one: Cloudflare profiles Node's TLS
// ClientHello, which is why dev used to need a curl hop. Workerd's fetch is
// not Node's TLS stack, so this route serves dev and production alike — and
// whether the fingerprint passes is now decided by the same code in both. If
// Cloudflare challenges it, proxyTo answers 503 with `x-proxy-challenge` and
// the app degrades to its explicit challenge error.
// `redirects: 'follow'` matches what the curl hop's `--location` did.
const handler = ({ request }: { request: Request }) =>
  proxyTo(request, {
    prefix: '/novelfull',
    target: 'https://novelfull.com',
    redirects: 'follow',
    browserHeaders: true,
  })

export const Route = createFileRoute('/novelfull/$')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
