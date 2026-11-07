import { resolveObjectURL } from 'node:buffer'
import { setTimeout as delay } from 'node:timers/promises'
import { sourceProxyPolicies, SOURCE_BROWSER_HEADERS } from '../../../src/lib/transport/source-policy'
import { ChallengeRequiredError, HttpStatusError } from '../../../src/lib/transport/types'
import type { HttpRequest, HttpResponse, HttpTransport } from '../../../src/lib/transport/types'
import type { ProxyToOptions } from '../../../src/server/proxy'

const policies = Object.values(sourceProxyPolicies)
const policiesByOrigin = new Map(policies.map((policy) => [new URL(policy.target).origin, policy]))
const hostPolicies = policies.filter((policy) => policy.hostPattern)
let mangaPlusSession: string | undefined
let mangaHubKey: string | undefined

export class RateLimiter {
  private timestamps: number[] = []

  constructor(private readonly permits: number, private readonly periodMs: number, private readonly exclude: (url: URL) => boolean = () => false) {}

  async acquire(url: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.exclude(new URL(url, 'https://kagi.invalid'))) return
    for (;;) {
      signal?.throwIfAborted()
      const now = Date.now()
      this.timestamps = this.timestamps.filter((time) => now - time < this.periodMs)
      if (this.timestamps.length < this.permits) {
        this.timestamps.push(now)
        return
      }
      await delay(this.periodMs - (now - this.timestamps[0]) + 1, undefined, { signal })
    }
  }
}

export interface ResolvedSourceRequest {
  url: URL
  policy?: ProxyToOptions
  headers: Headers
  xorKey?: Uint8Array
}

export function resolveSourceRequest(input: string, extraHeaders?: Record<string, string>): ResolvedSourceRequest {
  const incoming = new URL(input, 'https://kagi.invalid')
  if (incoming.protocol !== 'https:' && incoming.protocol !== 'http:') throw new Error('Source requests must use HTTP or HTTPS.')
  let url = new URL(incoming)
  const prefix = `/${incoming.pathname.split('/')[1]}`
  const directPolicy = policiesByOrigin.get(url.origin)
    ?? hostPolicies.find((item) => item.hostPattern!.test(url.hostname))
  let policy: ProxyToOptions | undefined
  if (input.startsWith('/') || incoming.hostname === 'kagi.invalid' || (!directPolicy && sourceProxyPolicies[prefix])) {
    policy = sourceProxyPolicies[prefix]
    if (!policy) throw new Error(`Unknown source route: ${prefix}`)
    let path = incoming.pathname.slice(prefix.length)
    let origin = new URL(policy.target).origin
    if (policy.hostPattern) {
      const [, host, ...rest] = path.split('/')
      if (!host || !policy.hostPattern.test(host)) throw new Error('Source image host is not allowed.')
      origin = `https://${host}`
      path = `/${rest.join('/')}`
    }
    url = new URL(`${path || '/'}${incoming.search}`, origin)
    if (url.origin !== origin) throw new Error('Source path escaped its configured origin.')
  } else {
    policy = directPolicy
    if (!policy && url.hostname === 'novelmtl.com') policy = sourceProxyPolicies['/novelmtl']
  }
  if (sourceProxyPolicies['/mangapluscdn'].hostPattern?.test(url.hostname) && (url.searchParams.has('vw') || url.searchParams.has('key'))) {
    policy = sourceProxyPolicies['/mangapluscdn']
  }
  const headers = new Headers(policy?.browserHeaders ? SOURCE_BROWSER_HEADERS : { 'User-Agent': SOURCE_BROWSER_HEADERS['User-Agent'] })
  if (policy?.userAgent) headers.set('User-Agent', policy.userAgent)
  if (policy?.referer) headers.set('Referer', policy.referer)
  if (policy?.cookies) headers.set('Cookie', Object.entries(policy.cookies).map(([key, value]) => `${key}=${value}`).join('; '))
  for (const [key, value] of Object.entries(policy?.headers ?? {})) headers.set(key, value)
  for (const [key, value] of Object.entries(extraHeaders ?? {})) headers.set(key, value)
  if (policy?.prefix === '/mangaplus') {
    mangaPlusSession ??= crypto.randomUUID()
    headers.set('SESSION-TOKEN', mangaPlusSession)
  }
  for (const [param, header] of Object.entries(policy?.headerParams ?? {})) {
    const value = url.searchParams.get(param)
    if (value !== null) headers.set(header, value)
    url.searchParams.delete(param)
  }
  let xorKey: Uint8Array | undefined
  if (policy?.xorKeyParam) {
    const hex = url.searchParams.get(policy.xorKeyParam)
    if (hex) {
      if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error('MANGA Plus returned an invalid image encryption key.')
      xorKey = Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16))
    }
    url.searchParams.delete(policy.xorKeyParam)
  }
  return { url, policy, headers, xorKey }
}

async function assertSourceResponse(response: Response, url: string): Promise<void> {
  if (response.ok) return
  if ([403, 429, 503].includes(response.status)) {
    let challenge = response.headers.get('cf-mitigated') === 'challenge'
    if (!challenge) {
      const body = await response.clone().text()
      challenge = /Just a moment|cf-chl-|challenge-platform/i.test(body.slice(0, 4096))
    }
    if (challenge) {
      await response.body?.cancel()
      throw new ChallengeRequiredError(url, url)
    }
  }
  await response.body?.cancel()
  throw new HttpStatusError(response.status, url)
}

async function sourceResponse(req: HttpRequest): Promise<{ response: Response; url: string }> {
  let resolved = resolveSourceRequest(req.url, req.headers)
  let method = req.method ?? 'GET'
  let body = req.body
  for (let redirects = 0; redirects <= 20; redirects++) {
    req.signal?.throwIfAborted()
    const response = await globalThis.fetch(resolved.url, {
      method, headers: resolved.headers, body, redirect: 'manual', signal: req.signal,
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) throw new Error('Source returned a redirect without a destination.')
      const next = new URL(location, resolved.url)
      if (next.protocol !== 'https:' && next.protocol !== 'http:') throw new Error('Source redirect used a non-HTTP destination.')
      const sameOrigin = next.origin === resolved.url.origin
      const nextResolved = resolveSourceRequest(next.href, sameOrigin ? req.headers : undefined)
      if (sameOrigin) {
        nextResolved.headers = resolved.headers
        nextResolved.policy = resolved.policy
      }
      if (resolved.policy?.hostPattern?.test(next.hostname)) {
        for (const name of Object.values(resolved.policy.headerParams ?? {})) {
          const value = resolved.headers.get(name)
          if (value !== null) nextResolved.headers.set(name, value)
        }
      }
      nextResolved.xorKey ??= resolved.xorKey
      resolved = nextResolved
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET'
        body = undefined
        resolved.headers.delete('Content-Type')
        resolved.headers.delete('Content-Length')
      }
      continue
    }
    await assertSourceResponse(response, resolved.url.href)
    if (!resolved.xorKey || !response.body) return { response, url: resolved.url.href }
    const key = resolved.xorKey
    let position = 0
    const decoded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        for (let index = 0; index < chunk.length; index++) chunk[index] ^= key[position++ % key.length]
        controller.enqueue(chunk)
      },
    }))
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    headers.delete('content-encoding')
    return { response: new Response(decoded, { status: response.status, headers }), url: resolved.url.href }
  }
  throw new Error('Source exceeded 20 redirects.')
}

async function mangaHubResponse(req: HttpRequest): Promise<{ response: Response; url: string }> {
  const body = req.body
  if (req.method !== 'POST' || typeof body !== 'string' || body.length > 4096) throw new Error('Invalid MangaHub GraphQL request.')
  const parsed: unknown = JSON.parse(body)
  if (!parsed || typeof parsed !== 'object' || !('query' in parsed) || typeof parsed.query !== 'string') throw new Error('Body is not a GraphQL query.')
  const site = 'https://mangakakalot.fun'
  const url = 'https://api.mghcdn.com/graphql'
  for (let attempt = 0; attempt < 2; attempt++) {
    req.signal?.throwIfAborted()
    if (!mangaHubKey) {
      const page = await globalThis.fetch(`${site}/`, { headers: { 'User-Agent': SOURCE_BROWSER_HEADERS['User-Agent'] }, signal: req.signal })
      await assertSourceResponse(page, site)
      const key = /mhub_access=([0-9a-f]+)/.exec(page.headers.getSetCookie().join('; '))?.[1]
      await page.body?.cancel()
      if (!key) throw new Error('MangaHub served no access key.')
      mangaHubKey = key
    }
    const response = await globalThis.fetch(url, { method: 'POST', body, signal: req.signal, headers: {
      'Content-Type': 'application/json', 'User-Agent': SOURCE_BROWSER_HEADERS['User-Agent'], Origin: site, Referer: `${site}/`, 'x-mhub-access': mangaHubKey,
    } })
    const text = await response.text()
    if (attempt === 0 && (response.status === 404 || (text.includes('"errors"') && /rate limit/i.test(text)))) {
      mangaHubKey = undefined
      continue
    }
    const answer = new Response(text, { status: response.status, headers: response.headers })
    await assertSourceResponse(answer, url)
    return { response: answer, url }
  }
  throw new Error('MangaHub refused its refreshed access key.')
}

export class DirectFetchTransport implements HttpTransport {
  constructor(private readonly limiter?: RateLimiter) {}

  async fetch(req: HttpRequest): Promise<HttpResponse> {
    await this.limiter?.acquire(req.url, req.signal)
    req.signal?.throwIfAborted()
    const address = new URL(req.url, 'https://kagi.invalid')
    const isMangaHub = address.pathname === '/mangakakalot/graphql' || address.hostname === 'api.mghcdn.com'
    const { response, url } = await (isMangaHub ? mangaHubResponse(req) : sourceResponse(req))
    return {
      status: response.status, url, headers: response.headers,
      text: () => response.text(),
      json: <T,>() => response.json() as Promise<T>,
      arrayBuffer: () => response.arrayBuffer(),
    }
  }
}

const imagePaces = new Map<string, { next: number; tail: Promise<void> }>()

export async function fetchSourceImage(sourceId: string, url: string, signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted()
  const { getSource } = await import('../../../src/lib/sources/registry')
  const source = getSource(sourceId)
  if (url.startsWith('blob:')) {
    const blob = resolveObjectURL(url)
    if (!blob) throw new Error('The local image URL has expired. Reopen the chapter.')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    signal?.throwIfAborted()
    return bytes
  }
  const interval = source.pageFetchIntervalMs
  let pace = imagePaces.get(sourceId)
  if (!pace) {
    pace = { next: 0, tail: Promise.resolve() }
    imagePaces.set(sourceId, pace)
  }
  const state = pace
  const slot = state.tail.catch(() => undefined).then(async () => {
    signal?.throwIfAborted()
    const wait = state.next - Date.now()
    if (wait > 0) await delay(wait, undefined, { signal })
    signal?.throwIfAborted()
    state.next = Date.now() + interval
  })
  state.tail = slot.catch(() => undefined)
  await slot
  const { response } = await sourceResponse({ url, signal })
  const bytes = new Uint8Array(await response.arrayBuffer())
  signal?.throwIfAborted()
  return bytes
}
