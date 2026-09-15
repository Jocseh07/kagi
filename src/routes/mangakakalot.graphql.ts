import { createFileRoute } from '@tanstack/react-router'

import { mangahubGraphql } from '@/server/mangahub'

// Mangakakalot's API. Not `proxyTo`: that hop is GET/HEAD only and forwards no
// body, and this endpoint needs a POST plus two headers the page cannot set.
// See src/server/mangahub.ts.
export const Route = createFileRoute('/mangakakalot/graphql')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          return await mangahubGraphql(request)
        } catch {
          return new Response('MangaHub could not be reached', { status: 502 })
        }
      },
    },
  },
})
