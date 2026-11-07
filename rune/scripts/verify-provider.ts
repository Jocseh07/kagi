import assert from 'node:assert/strict'
import { createInterface } from 'node:readline'
import { FIXTURES, MODELS, validateFixtures } from './verify-fixtures'

export type Fault = 'none' | 'malformed' | '429' | '5xx' | 'timeout' | 'offline' | 'dialogue-loss'
export interface ProviderStats { requests: number; text: number; image: number; active: number; peak: number; injected: number; unexpected: number; priority: number; faultsRemaining: number; firstAt: number; lastAt: number; sourceRequests: number; sourceImages: number; sourceActive: number }
export interface ProviderControl { fault?: Fault; remaining?: number; stats?: boolean; sourceFault?: 'none' | 'hold' | 'offline' | 'corrupt'; sourceRemaining?: number }
export interface ProviderHandle { endpoint: string; control(value: ProviderControl): Promise<ProviderStats>; stop(): Promise<void> }

async function main(): Promise<void> {
  await validateFixtures()
  const image = Bun.file(process.argv[2])
  assert(await image.exists(), 'Provider needs a deterministic PNG fixture')
  let fault: Fault = 'none'
  let remaining = 0
  const waiting = new Set<() => void>()
  let sourceFault: 'none' | 'hold' | 'offline' | 'corrupt' = 'none'
  let sourceRemaining = 0
  const sourceWaiting = new Set<() => void>()
  const stats: ProviderStats = { requests: 0, text: 0, image: 0, active: 0, peak: 0, injected: 0, unexpected: 0, priority: 0, faultsRemaining: 0, firstAt: 0, lastAt: 0, sourceRequests: 0, sourceImages: 0, sourceActive: 0 }
  const release = () => { for (const resolve of waiting) resolve(); waiting.clear(); for (const resolve of sourceWaiting) resolve(); sourceWaiting.clear() }
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, maxRequestBodySize: 16 * 1024 * 1024,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/__control') {
        const value = await request.json() as ProviderControl
        if (value.fault !== undefined) { release(); fault = value.fault; remaining = value.remaining ?? 1; stats.faultsRemaining = remaining }
        if (value.sourceFault !== undefined) { for (const resolve of sourceWaiting) resolve(); sourceWaiting.clear(); sourceFault = value.sourceFault; sourceRemaining = value.sourceRemaining ?? 50_000 }
        return Response.json(stats)
      }
      if (url.pathname === '/__source') {
        stats.sourceRequests++
        if (stats.sourceRequests > 50_000) return new Response('Source fixture hard cap reached', { status: 429 })
        const original = new URL(url.searchParams.get('url') ?? 'https://invalid.invalid')
        const isImage = original.hostname === 'cdn.asurascans.com'
        if (sourceFault === 'offline' && sourceRemaining-- > 0) return new Response('Source fixture offline', { status: 503 })
        if (isImage) {
          stats.sourceImages++
          if (sourceFault === 'corrupt' && sourceRemaining-- > 0) return new Response('broken PNG', { headers: { 'Content-Type': 'image/png' } })
          if (sourceFault === 'hold' && sourceRemaining-- > 0) {
            const { promise, resolve } = Promise.withResolvers<void>()
            sourceWaiting.add(resolve); stats.sourceActive++
            const abort = () => { sourceWaiting.delete(resolve); resolve() }
            request.signal.addEventListener('abort', abort, { once: true })
            try { await promise } finally { stats.sourceActive--; sourceWaiting.delete(resolve); request.signal.removeEventListener('abort', abort) }
          }
          return new Response(image, { headers: { 'Content-Type': 'image/png' } })
        }
        const slug = original.pathname.includes('native-mihon-fixture') ? 'native-mihon-fixture' : 'native-download-fixture'
        const series = { id: 429, slug, title: slug === 'native-mihon-fixture' ? 'Native Mihon fixture' : 'Native download fixture', description: '<p>A deterministic source fixture.</p>', author: 'Fixture', status: 'ongoing', cover: 'https://cdn.asurascans.com/asura-images/native-fixture/cover.png' }
        const chapters = [1, 2, 3].map((number) => ({ id: number, series_id: 429, number, slug: String(number), page_count: 3, is_premium: false }))
        if (original.pathname === '/api/genres') return Response.json({ data: [{ id: 1, name: 'Adventure', slug: 'adventure' }] })
        if (original.pathname === '/api/series') return Response.json({ data: [series], meta: { total: 1, per_page: 20 } })
        if (original.pathname === `/api/series/${slug}`) return Response.json({ series, recommended_series: [] })
        if (original.pathname === `/api/series/${slug}/chapters`) return Response.json({ data: chapters })
        const chapter = /chapters[/]([1-3])$/.exec(original.pathname)
        if (chapter) return Response.json({ data: { is_locked: false, chapter: { ...chapters[Number(chapter[1]) - 1], pages: [0, 1, 2].map((page) => ({ url: `https://cdn.asurascans.com/asura-images/native-fixture/${chapter[1]}-${page}.png` })) } } })
        stats.unexpected++
        return new Response('Unexpected source fixture path', { status: 404 })
      }
      stats.requests++
      if (stats.requests > 50_000) return Response.json({ error: { message: 'Harness provider hard request cap reached' } }, { status: 429 })
      if (request.headers.has('authorization')) { stats.unexpected++; return new Response('Harness never accepts provider credentials', { status: 403 }) }
      const allowed = ['/v1/models', '/v1/chat/completions', '/v1/images/generations', '/v1/images/edits']
      if (!allowed.includes(url.pathname)) { stats.unexpected++; return new Response('Unexpected deterministic provider route', { status: 404 }) }
      stats.lastAt = performance.now(); if (!stats.firstAt) stats.firstAt = stats.lastAt
      if (remaining > 0) {
        remaining--; stats.injected++; stats.faultsRemaining = remaining
        if (fault === '429' || fault === '5xx' || fault === 'offline') return Response.json({ error: { message: `Deterministic ${fault}` } }, { status: fault === '429' ? 429 : 503, headers: fault === '429' ? { 'Retry-After': '0.5' } : {} })
        if (fault === 'timeout') {
          const { promise, resolve } = Promise.withResolvers<void>()
          waiting.add(resolve); stats.active++
          const aborted = () => { waiting.delete(resolve); resolve() }
          request.signal.addEventListener('abort', aborted, { once: true })
          try { await promise } finally { stats.active--; waiting.delete(resolve); request.signal.removeEventListener('abort', aborted) }
          return new Response('Released timeout fixture', { status: 504 })
        }
        if (fault === 'malformed') return Response.json({ choices: [{ message: { content: '{"unterminated":' }, finish_reason: 'stop' }] })
      }
      if (url.pathname === '/v1/models') return Response.json({ data: [...new Set(Object.values(MODELS))].map((id) => ({ id })) })
      stats.active++; stats.peak = Math.max(stats.peak, stats.active)
      try {
        if (url.pathname.includes('/images/')) {
          stats.image++
          let model: unknown
          if (request.headers.get('content-type')?.includes('multipart/form-data')) model = (await request.formData()).get('model')
          else model = (await request.json() as { model?: unknown }).model
          if (model !== MODELS.imageModel) { stats.unexpected++; return new Response('Configured image model changed', { status: 400 }) }
          return Response.json({ data: [{ b64_json: Buffer.from(await image.arrayBuffer()).toString('base64') }] })
        }
        stats.text++
        const body = await request.json() as { model?: unknown; service_tier?: unknown; messages?: { role: string; content: unknown }[] }
        if (body.model !== MODELS.planningModel) { stats.unexpected++; return new Response('Configured text model changed', { status: 400 }) }
        if (body.service_tier !== undefined) { stats.priority++; if (body.service_tier !== 'priority') stats.unexpected++ }
        const system = body.messages?.find((message) => message.role === 'system')?.content
        const user = JSON.stringify(body.messages?.filter((message) => message.role !== 'system'))
        if (typeof system !== 'string') { stats.unexpected++; return new Response('Missing system prompt', { status: 400 }) }
        const fixture = FIXTURES.find((entry) => entry.id === 'dialogue-heavy' && user.includes('Is this your key?')) ?? FIXTURES.find((entry) => entry.id === 'action-heavy' && user.includes('Catch the key!')) ?? FIXTURES[0]
        let output: unknown
        if (system.startsWith('You plan a manga adaptation')) {
          const numbers = [...user.matchAll(/Novel chapter (\d+):/g)].map((match) => Number(match[1]))
          if (!numbers.length) { stats.unexpected++; return new Response('Unrecognized planning prompt', { status: 400 }) }
          output = { ...fixture.plan, chapters: numbers.map((index) => ({ ...fixture.plan.chapters[0], novelChapters: [index] })) }
        } else if (system.startsWith('You break web novel chapters')) output = fixture.beats
        else if (system.includes('beat: the index') || system.includes('"pages"')) {
          const pages = structuredClone(fixture.pages)
          if (fault === 'dialogue-loss' && stats.faultsRemaining > 0) {
            remaining--; stats.injected++; stats.faultsRemaining = remaining
            for (const page of pages) for (const panel of page.panels) panel.text = []
          }
          output = { pages }
        } else if (system.includes('"ok"') || system.includes('"issue"')) output = { ok: true, issue: '' }
        else if (system.includes('"prompt"')) output = { prompt: fixture.pages[0].panels[0].prompt }
        else { stats.unexpected++; return new Response('Unrecognized generation stage', { status: 400 }) }
        return Response.json({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] })
      } finally { stats.active-- }
    },
  })
  process.stdout.write(JSON.stringify({ endpoint: `http://127.0.0.1:${server.port}/v1`, pid: process.pid }) + '\n')
  const input = createInterface({ input: process.stdin })
  const stop = () => { release(); server.stop(true); input.close() }
  input.once('close', stop)
  process.once('SIGTERM', stop)
}
if (import.meta.main) await main()
