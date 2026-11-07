/**
 * The latest Android APK, streamed from the releases bucket. A plain link
 * target: Settings, the Home strip and `release:pull` all point here.
 */

import { createFileRoute } from '@tanstack/react-router'
import * as Effect from 'effect/Effect'

import { runServer } from '@/server/effect/run'
import { respondTo } from '@/server/errors'
import { limitReleaseRequest, serveLatestApk } from '@/server/releases'

const handler = async ({ request }: { request: Request }) => {
  try {
    return await runServer(
      Effect.gen(function* () {
        yield* limitReleaseRequest(request)
        return yield* serveLatestApk(request)
      }),
    )
  } catch (error) {
    return respondTo(error)
  }
}

export const Route = createFileRoute('/download/android')({
  server: {
    handlers: { GET: handler, HEAD: handler },
  },
})
