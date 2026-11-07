import * as Effect from 'effect/Effect'

import { isReleaseId, parseInstalledRelease, parseReleaseRecord, resolveUpdate } from '@/lib/app-update'
import type { Artifact, ReleaseRecord } from '@/lib/app-update'
import { Env } from './effect/env'
import { attempt } from './effect/errors'
import type { R2Bucket } from '@cloudflare/workers-types'

const releaseStorage = Effect.gen(function* () {
  const env = yield* Env
  return {
    optionalBucket: Effect.succeed(env.RELEASES ?? null),
    use: <A>(fn: (bucket: R2Bucket) => Promise<A>) => attempt(() => {
      if (!env.RELEASES) throw new Error('Release storage is unavailable.')
      return fn(env.RELEASES)
    }, 'Release storage is unavailable.'),
  }
})

const unavailable = () => new Response('Update information is unavailable.', { status: 503, headers: { 'cache-control': 'no-store' } })

export const readReleaseRecord = Effect.fn('readReleaseRecord')(function* (id: string) {
  if (!isReleaseId(id)) return null
  const storage = yield* releaseStorage
  if (!(yield* storage.optionalBucket)) return null
  const stored = yield* storage.use((bucket) => bucket.get(`releases/${id}/record.json`))
  if (!stored) return null
  const text = yield* storage.use(() => stored.text())
  try {
    const record = parseReleaseRecord(JSON.parse(text))
    return record?.id === id ? record : null
  } catch {
    return null
  }
})

export const readActiveRelease = Effect.fn('readActiveRelease')(function* () {
  const env = yield* Env
  return env.APP_RELEASE_ID ? yield* readReleaseRecord(env.APP_RELEASE_ID) : null
})

export function serveUpdateCheck(request: Request) {
  return Effect.gen(function* () {
    const url = new URL(request.url)
    const installed = parseInstalledRelease(url.searchParams)
    if (!installed) return new Response('Invalid installed version.', { status: 400 })
    const record = yield* readActiveRelease().pipe(Effect.catch(() => Effect.succeed(null)))
    if (!record) return unavailable()
    const result = resolveUpdate(record, installed, url.origin)
    if (!result) return unavailable()
    if (result.status === 'latest' && installed.requiredReleaseId && installed.requiredReleaseId !== record.id) {
      const required = yield* readReleaseRecord(installed.requiredReleaseId)
      const activeTarget = record.platforms[installed.platform]
      const previousTarget = required?.platforms[installed.platform]
      if (required && activeTarget && previousTarget && activeTarget.build >= previousTarget.build
        && Date.parse(record.createdAt) > Date.parse(required.createdAt)) {
        return Response.json({ ...result, satisfiedReleaseIds: [required.id] }, { headers: { 'cache-control': 'no-store' } })
      }
    }
    return Response.json(result, { headers: { 'cache-control': 'no-store' } })
  })
}

function pinnedRelease(header: string | null): string | null {
  if (!header || header.length > 4096) return null
  const members: string[] = []
  let start = 0
  let quoted = false
  let escaped = false
  let depth = 0
  for (let index = 0; index < header.length; index++) {
    const character = header[index]
    if (escaped) { escaped = false; continue }
    if (quoted && character === '\\') { escaped = true; continue }
    if (character === '"') quoted = !quoted
    if (!quoted && character === '(') depth++
    if (!quoted && character === ')') depth--
    if (depth < 0) return null
    if (!quoted && depth === 0 && character === ',') {
      members.push(header.slice(start, index).trim())
      start = index + 1
    }
  }
  if (quoted || escaped || depth !== 0) return null
  members.push(header.slice(start).trim())
  let releaseId: string | null = null
  for (const member of members) {
    const key = /^([a-z*][a-z0-9_.*-]*)\s*(?:=|;|$)/.exec(member)?.[1]
    if (!key) return null
    if (key !== 'releaseid') continue
    if (releaseId !== null) return null
    const match = /^releaseid="((?:[^"\\]|\\["\\])*)"(?:;[a-z*][a-z0-9_.*-]*(?:=(?:"(?:[^"\\]|\\["\\])*"|[^;, ]+))?)*$/.exec(member)
    if (!match) return null
    const id = match[1].replace(/\\(["\\])/g, '$1')
    if (!isReleaseId(id)) return null
    releaseId = id
  }
  return releaseId
}

function artifactHeaders(artifact: Artifact) {
  return new Headers({
    'content-type': artifact.contentType,
    'cache-control': 'public, max-age=31536000, immutable',
    'accept-ranges': 'bytes',
    etag: `"${artifact.sha256}"`,
    'x-content-type-options': 'nosniff',
  })
}

export const serveReleaseArtifact = Effect.fn('serveReleaseArtifact')(function* (request: Request, releaseId: string, path: string) {
  const record = yield* readReleaseRecord(releaseId)
  const artifact = record && Object.hasOwn(record.artifacts, path) ? record.artifacts[path] : undefined
  if (!record || !artifact) return new Response('Not found', { status: 404 })
  return yield* serveArtifact(request, record, artifact)
})

const serveArtifact = Effect.fn('serveArtifact')(function* (request: Request, record: ReleaseRecord, artifact: Artifact) {
  const storage = yield* releaseStorage
  const headers = artifactHeaders(artifact)
  if (request.headers.get('if-none-match')?.split(',').map((tag) => tag.trim()).includes(headers.get('etag')!)) {
    return new Response(null, { status: 304, headers })
  }
  let offset = 0
  let length = artifact.sizeBytes
  const range = request.headers.get('range')
  const ifRange = request.headers.get('if-range')
  const useRange = range && (!ifRange || ifRange === headers.get('etag'))
  if (useRange) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${artifact.sizeBytes}` } })
    if (!match[1]) {
      length = Math.min(Number(match[2]), artifact.sizeBytes)
      offset = artifact.sizeBytes - length
    } else {
      offset = Number(match[1])
      const end = match[2] ? Math.min(Number(match[2]), artifact.sizeBytes - 1) : artifact.sizeBytes - 1
      length = end - offset + 1
    }
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0 || offset >= artifact.sizeBytes) {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${artifact.sizeBytes}` } })
    }
  }
  const key = `releases/${record.id}/${artifact.path}`
  const stored = request.method === 'HEAD'
    ? yield* storage.use((bucket) => bucket.head(key))
    : yield* storage.use((bucket) => bucket.get(key, useRange ? { range: { offset, length } } : undefined))
  if (!stored || stored.size !== artifact.sizeBytes || (stored.customMetadata?.sha256 !== undefined && stored.customMetadata.sha256 !== artifact.sha256)) return unavailable()
  headers.set('content-length', String(length))
  if (artifact.contentType === 'application/vnd.android.package-archive') headers.set('content-disposition', `attachment; filename="kagi-${record.platforms.android.version}-${record.platforms.android.build}.apk"`)
  if (useRange) headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${artifact.sizeBytes}`)
  const body = request.method === 'HEAD' || !('body' in stored) ? null : stored.body as unknown as ReadableStream
  return new Response(body, { status: useRange ? 206 : 200, headers })
})

export function serveExpoUpdate(request: Request) {
  return Effect.gen(function* () {
    const platform = request.headers.get('expo-platform')
    const runtime = request.headers.get('expo-runtime-version')
    const protocol = request.headers.get('expo-protocol-version')
    if ((platform !== 'android' && platform !== 'ios') || protocol !== '1' || !runtime) return new Response('Invalid update request.', { status: 400 })
    const accept = request.headers.get('accept') ?? '*/*'
    const acceptsMultipart = accept.split(',').some((part) => {
      const [mediaType, ...parameters] = part.trim().split(';')
      const quality = parameters.find((parameter) => parameter.trim().startsWith('q='))
      return ['multipart/mixed', 'multipart/*', '*/*'].includes(mediaType) && (!quality || Number(quality.trim().slice(2)) > 0)
    })
    if (!acceptsMultipart) return new Response('Multipart updates are required.', { status: 406 })
    const releaseId = pinnedRelease(request.headers.get('expo-extra-params'))
    if (!releaseId) return new Response('Select a release before downloading.', { status: 400 })
    const record = yield* readReleaseRecord(releaseId)
    const ota = record?.platforms[platform]?.ota
    if (!record || !ota || ota.runtimeVersion !== runtime) return unavailable()
    const storage = yield* releaseStorage
    const stored = yield* storage.use((bucket) => bucket.get(`releases/${record.id}/${ota.manifest.path}`))
    if (!stored || stored.size !== ota.manifest.sizeBytes) return unavailable()
    const bytes = yield* storage.use(() => stored.arrayBuffer())
    const digest = yield* attempt(() => crypto.subtle.digest('SHA-256', bytes), 'Could not verify the update.')
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
    if (hash !== ota.manifest.sha256) return unavailable()
    const manifest = new TextDecoder().decode(bytes)
    const boundary = `expo-${crypto.randomUUID()}`
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/json\r\nexpo-signature: sig="${ota.signature}", keyid="main", alg="rsa-v1_5-sha256"\r\n\r\n${manifest}\r\n--${boundary}\r\nContent-Disposition: form-data; name="extensions"\r\nContent-Type: application/json\r\n\r\n{}\r\n--${boundary}--\r\n`
    return new Response(body, { headers: {
      'content-type': `multipart/mixed; boundary=${boundary}`,
      'expo-protocol-version': '1', 'expo-sfv-version': '0',
      'expo-manifest-filters': `releaseid="${record.id}"`, 'expo-server-defined-headers': '',
      'cache-control': 'no-store', 'vary': 'expo-platform, expo-runtime-version, expo-extra-params',
    } })
  })
}
