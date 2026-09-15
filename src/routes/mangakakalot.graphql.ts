import { createFileRoute } from '@tanstack/react-router'

import { mangahubGraphql } from '@/server/mangahub'
import { rateLimited } from '@/server/rate-limit'

// Mangakakalot's API. Not `proxyTo`: that hop is GET/HEAD only and forwards no
// body, and this endpoint needs a POST plus two headers the page cannot set.
// See src/server/mangahub.ts.
export const Route = createFileRoute('/mangakakalot/graphql')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Not `proxyTo`, so not covered by its check; same bucket.
        const limited = await rateLimited(request, 'RATE_PROXY')
        if (limited) return limited
        try {
          return await mangahubGraphql(request)
        } catch {
          return new Response('MangaHub could not be reached', { status: 502 })
        }
      },
    },
  },
})
