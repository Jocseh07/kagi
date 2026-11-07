/**
 * The Android release the mobile app's `release:android` script last
 * published: `android/latest.json` names the APK object beside it.
 *
 * The script writes the APK first and `latest.json` last, so a release that
 * is named here is always fully uploaded.
 */

import * as Effect from 'effect/Effect'

import { parseAppRelease } from '@/lib/app-release'
import type { AppRelease } from '@/lib/app-release'
import { AppError } from './errors'
import { Env } from './effect/env'
import { attempt, fail } from './effect/errors'
import { readActiveRelease } from './app-update'
import { RateLimits } from './effect/rate-limits'

const LATEST_KEY = 'android/latest.json'
const APK_TYPE = 'application/vnd.android.package-archive'

export const readLatestRelease = Effect.fn('releases.readLatest')(function* () {
  const env = yield* Env
  const bucket = env.RELEASES
  if (env.APP_RELEASE_ID) {
    const record = yield* readActiveRelease()
    const android = record?.platforms.android
    if (!record || !android?.apk) return null
    return {
      version: android.version, versionCode: android.build,
      file: `releases/${record.id}/${android.apk.path}`,
      size: android.apk.sizeBytes, sha256: android.apk.sha256, publishedAt: record.createdAt,
    }
  }
  if (!bucket) return null

  return yield* attempt(async () => {
    const object = await bucket.get(LATEST_KEY)
    if (!object) return null
    return parseAppRelease(await object.json<unknown>())
  }, 'The release could not be read.')
})

/** One budget per address for both release routes; the APK is the heavy one. */
export const limitReleaseRequest = Effect.fn('releases.limit')(function* (request: Request) {
  const rateLimits = yield* RateLimits
  const key = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const limited = yield* rateLimits.limit('RATE_API', key)
  if (limited) {
    return yield* Effect.fail(new AppError(429, 'Too many requests. Try again in a minute.'))
  }
})

/** The latest APK, with range and HEAD support so interrupted downloads resume. */
export const serveLatestApk = Effect.fn('releases.serveApk')(function* (request: Request) {
  const env = yield* Env
  const release = yield* readLatestRelease()
  const bucket = env.RELEASES
  if (!release || !bucket) return yield* fail(404, 'No release published.')

  const head = request.method === 'HEAD'
  const object = yield* Effect.tryPromise({
    try: () =>
      head
        ? bucket.head(release.file)
        : bucket.get(release.file, { range: request.headers as never }),
    catch: () => new AppError(416, 'Range not satisfiable.'),
  })
  if (!object) return yield* fail(404, 'No release published.')

  const headers = new Headers({
    'Content-Type': APK_TYPE,
    'Content-Disposition': `attachment; filename="${apkFileName(release)}"`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': env.APP_RELEASE_ID ? 'no-store' : 'public, max-age=300',
    ETag: object.httpEtag,
  })

  const body = 'body' in object ? (object.body as unknown as BodyInit) : null
  const range = request.headers.has('range') && 'body' in object ? object.range : undefined
  if (!range) {
    headers.set('Content-Length', String(object.size))
    return new Response(body, { headers })
  }

  const suffix = 'suffix' in range && typeof range.suffix === 'number' ? range.suffix : undefined
  const offset = suffix !== undefined ? object.size - suffix : ('offset' in range ? (range.offset ?? 0) : 0)
  const length =
    suffix ?? ('length' in range ? (range.length ?? object.size - offset) : object.size - offset)
  headers.set('Content-Length', String(length))
  headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`)
  return new Response(body, { status: 206, headers })
})

function apkFileName(release: AppRelease): string {
  return `kagi-${release.version}.apk`
}
