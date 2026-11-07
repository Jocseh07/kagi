/**
 * The latest published Android build, for the download section in Settings
 * and the strip on Home. 404 until the first `release:android` upload.
 */

import { createFileRoute } from '@tanstack/react-router'
import * as Effect from 'effect/Effect'

import { runServer } from '@/server/effect/run'
import { fail } from '@/server/effect/errors'
import { respondTo } from '@/server/errors'
import { limitReleaseRequest, readLatestRelease } from '@/server/releases'

export const Route = createFileRoute('/api/app/release')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          return await runServer(
            Effect.gen(function* () {
              yield* limitReleaseRequest(request)
              const release = yield* readLatestRelease()
              if (!release) return yield* fail(404, 'No release published.')
              return Response.json(release, {
                headers: { 'Cache-Control': 'no-store' },
              })
            }),
          )
        } catch (error) {
          return respondTo(error)
        }
      },
    },
  },
})
