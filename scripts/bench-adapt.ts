import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { validateBeats, writeBeats } from '../src/lib/adapt/beats'
import { chatJson, editImage, generateImage } from '../src/lib/adapt/client'
import type { ContentPart } from '../src/lib/adapt/client'
import { createSlots } from '../src/lib/adapt/image-slots'
import { planBatch, validatePlan } from '../src/lib/adapt/planner'
import { validateScript, writeScript } from '../src/lib/adapt/script'
import type { AdaptSettings } from '../src/lib/adapt/settings'
import { adaptation, characters, fixtures, panelPrompts, sheetPrompt } from './bench-adapt-fixtures'

const TEXT_MODELS = ['claude-haiku-5-5', 'gpt-6-luna', 'claude-sonnet-5-5']
const IMAGE_MODELS = ['gpt-image-2.5-flare', 'gpt-image-2.5']
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HARD_CAP = { text: 180, image: 60 }
const baseline = {
  endpoint: 'http://localhost:8317/v1', apiKey: '', planningModel: 'claude-haiku-5-5',
  scriptModel: 'claude-haiku-5-5', imageModel: 'gpt-image-2.5-flare', concurrency: 32,
  chaptersAtOnce: 2, scriptsAhead: 3, readAhead: 3,
}

type Kind = 'text' | 'image'
type Quality = 'passed' | 'failed' | 'unknown'
type Context = {
  id: string; stage: string; model: string; fixture: string; round: number; concurrency: number
  attempts: number; jsonReplies: number; firstJson: boolean | null; controller: AbortController
}
type Result = {
  event: 'stage'; id: string; stage: string; model: string; fixture: string; round: number
  concurrency: number; elapsedMs: number; attempts: number; terminalSuccess: boolean
  firstPassSuccess: boolean; validJson: boolean | null; timeToValidOutputMs: number | null
  quality: Quality; criticalFidelityFailures: number | null; failure: string | null
}
const scope = new AsyncLocalStorage<Context>()

function integer(value: string | undefined, fallback: number, max: number): number {
  const result = Number(value ?? fallback)
  if (!Number.isInteger(result) || result < 1 || result > max) throw new Error('Invalid numeric option')
  return result
}

function append(fd: number, value: unknown): void {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
  let offset = 0
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset)
  fsyncSync(fd)
}

function contained(root: string, path: string): boolean {
  const part = relative(root, path)
  return part !== '..' && !part.startsWith('../') && !isAbsolute(part)
}

function numericUsage(value: unknown): unknown {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    if (!/^[a-z_]+$/.test(key)) return []
    const safe = numericUsage(entry)
    return safe === undefined ? [] : [[key, safe]]
  }))
}

function validJsonReply(data: unknown): boolean {
  if (!data || typeof data !== 'object' || !('choices' in data) || !Array.isArray(data.choices)) return false
  const choice: unknown = data.choices[0]
  if (!choice || typeof choice !== 'object' || !('message' in choice)) return false
  const message = choice.message
  if (!message || typeof message !== 'object' || !('content' in message)) return false
  const content = message.content
  if (typeof content !== 'string') return false
  try { const parsed: unknown = JSON.parse(content); return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) } catch { return false }
}

async function offline(): Promise<void> {
  const original = globalThis.fetch
  let requests = 0
  globalThis.fetch = (() => { requests++; throw new Error('Offline network forbidden') }) as typeof fetch
  try {
    const fixture = fixtures[0]
    assert.equal(validateBeats({ beats: fixture.input.beats, cut: [] }, fixture.text, characters).length, 0)
    const batch = [{ ref: { index: 1, name: fixture.id, url: '' }, text: fixture.text }]
    assert.ok(validatePlan(null, batch, false).length)
    assert.ok(validatePlan({ skip: [1], chapters: [], characters: [], props: [], places: [], memory: { summary: '', threads: [] } }, batch, false).length)
    assert.ok(validateBeats({ beats: [], cut: [] }, fixture.text).length)
    assert.ok(validateBeats({ beats: [{ moment: 'Key vanishes', weight: 'key', place: 'missing', cast: [], lines: [] }], cut: [] }, fixture.text).length)
    assert.ok(validateScript([], fixture.input).length)
    assert.ok(validateScript([{ layout: 'not-a-layout', panels: [] }], fixture.input).length)
    for (const malformed of [null, { beats: [null] }, { beats: [{ moment: 9, lines: [false] }] }]) {
      assert.ok(validateBeats(malformed, fixture.text).length, 'Malformed beats must produce validation errors')
    }
    for (const malformed of [null, [null], [{ layout: 'tiers', panels: [null] }]]) {
      assert.ok(validateScript(malformed, fixture.input).length, 'Malformed script must produce validation errors')
    }
    for (const limit of [4, 8, 16]) {
      const slots = createSlots()
      const signal = new AbortController().signal
      let active = 0
      let peak = 0
      let completed = 0
      const release: (() => void)[] = []
      const pending = Array.from({ length: limit + 2 }, () => slots(limit, 0, signal, async () => {
        active++; peak = Math.max(peak, active)
        const gate = Promise.withResolvers<void>()
        release.push(gate.resolve)
        await gate.promise
        active--; completed++
      }))
      await Promise.resolve(); await Promise.resolve()
      assert.equal(active, limit)
      while (completed < pending.length) {
        release.splice(0).forEach((resolve) => resolve())
        const tick = Promise.withResolvers<void>()
        setImmediate(tick.resolve)
        await tick.promise
      }
      await Promise.all(pending)
      assert.equal(peak, limit)
      assert.equal(active, 0)
      const cancelled = new AbortController(); cancelled.abort()
      await assert.rejects(slots(limit, 0, cancelled.signal, async () => assert.fail('Aborted slot ran')))
      await assert.rejects(slots(limit, 0, signal, async () => { throw new Error('Expected') }))
      let ran = false
      await slots(limit, 0, signal, async () => { ran = true })
      assert.equal(ran, true)
    }
    assert.equal(requests, 0)
    console.log(JSON.stringify({ event: 'offline', passed: true, requests }))
  } finally { globalThis.fetch = original }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    offline: { type: 'boolean' }, live: { type: 'boolean' }, help: { type: 'boolean' },
    'max-text-requests': { type: 'string' }, 'max-image-requests': { type: 'string' },
    output: { type: 'string' }, models: { type: 'string' }, rounds: { type: 'string' },
    'text-only': { type: 'boolean' }, 'image-only': { type: 'boolean' },
    'stage-timeout-ms': { type: 'string' }, 'run-timeout-ms': { type: 'string' }, verifier: { type: 'string' },
  }, strict: true })
  if (values.help) {
    console.log('bun scripts/bench-adapt.ts --offline\nbun scripts/bench-adapt.ts --live --max-text-requests 180 --max-image-requests 60 --output .tmp/bench-adapt/run-UNIQUE/results.jsonl\nOptions: --models comma-separated-known-models --rounds 2 --text-only --image-only --verifier claude-sonnet-5-5|none --stage-timeout-ms 180000 --run-timeout-ms 1500000\nAll live runs share .tmp/bench-adapt/requests.jsonl. Never remove that ledger to rerun this approved budget. Output must be new. Interrupted reservations remain spent. A stale .lock requires operator review before removal.')
    return
  }
  if (Boolean(values.offline) === Boolean(values.live)) throw new Error('Choose exactly one of --offline or --live')
  if (values.offline) return offline()
  if (values['text-only'] && values['image-only']) throw new Error('Choose only one workload filter')
  const cap = { text: integer(values['max-text-requests'], 180, 180), image: integer(values['max-image-requests'], 60, 60) }
  const rounds = integer(values.rounds, 2, 20)
  const stageTimeout = integer(values['stage-timeout-ms'], 180_000, 900_000)
  const runTimeout = integer(values['run-timeout-ms'], 1_500_000, 1_800_000)
  const selected = values.models?.split(',') ?? [...TEXT_MODELS, ...IMAGE_MODELS]
  if (!selected.length || selected.some((model) => ![...TEXT_MODELS, ...IMAGE_MODELS].includes(model))) throw new Error('Unknown candidate model')
  const textModels = values['image-only'] ? [] : TEXT_MODELS.filter((model) => selected.includes(model))
  const imageModels = values['text-only'] ? [] : IMAGE_MODELS.filter((model) => selected.includes(model))
  if (!textModels.length && !imageModels.length) throw new Error('No models match workload filters')
  const verifier = values.verifier ?? 'claude-sonnet-5-5'
  if (verifier !== 'none' && !TEXT_MODELS.includes(verifier)) throw new Error('Unknown verifier model')
  const endpoint = (process.env.BENCH_ADAPT_ENDPOINT?.trim() || baseline.endpoint).replace(/\/+$/, '')
  const endpointUrl = new URL(endpoint)
  if (!['http:', 'https:'].includes(endpointUrl.protocol) || endpointUrl.username || endpointUrl.password || endpointUrl.search || endpointUrl.hash) throw new Error('Invalid endpoint')
  const settings = { ...baseline, mode: 'custom', endpoint, apiKey: process.env.BENCH_ADAPT_API_KEY ?? '' } as AdaptSettings
  const tmp = resolve(ROOT, '.tmp')
  mkdirSync(tmp, { recursive: true })
  const tmpReal = realpathSync(tmp)
  const ledgerDir = resolve(tmp, 'bench-adapt')
  mkdirSync(ledgerDir, { recursive: true })
  if (!contained(tmpReal, realpathSync(ledgerDir))) throw new Error('Ledger outside approved directory')
  const outputPath = resolve(ROOT, values.output ?? `.tmp/bench-adapt/run-${Date.now()}-${randomUUID()}/results.jsonl`)
  if (!contained(tmp, outputPath) || outputPath === tmp || !outputPath.endsWith('.jsonl')) throw new Error('Output must be a new .jsonl file under .tmp')
  mkdirSync(dirname(outputPath), { recursive: true })
  if (!contained(tmpReal, realpathSync(dirname(outputPath)))) throw new Error('Output outside approved directory')
  const ledgerPath = resolve(ledgerDir, 'requests.jsonl')
  const lockPath = resolve(ledgerDir, '.lock')
  const lock = openSync(lockPath, 'wx', 0o600)
  let output: number | undefined
  let ledger: number | undefined
  const originalFetch = globalThis.fetch
  const totals = { text: 0, image: 0 }
  const results: Result[] = []
  const runId = randomUUID()
  const runController = new AbortController()
  const runTimer = setTimeout(() => runController.abort(new Error('Run deadline')), runTimeout)
  try {
    append(lock, { pid: process.pid, runId })
    if (existsSync(ledgerPath)) {
      if (!contained(tmpReal, realpathSync(ledgerPath))) throw new Error('Ledger outside approved directory')
      const raw = readFileSync(ledgerPath, 'utf8')
      if (raw && !raw.endsWith('\n')) throw new Error('Incomplete ledger requires operator review; no requests sent')
      for (const line of raw.split('\n').filter(Boolean)) {
        const entry = JSON.parse(line) as { event: string; kind: Kind }
        if (entry.event !== 'reserved' || !['text', 'image'].includes(entry.kind)) throw new Error('Invalid ledger; no requests sent')
        totals[entry.kind]++
      }
    }
    output = openSync(outputPath, 'wx', 0o600)
    ledger = openSync(ledgerPath, 'a', 0o600)
    const emit = (value: unknown) => {
      append(output!, value)
      console.log(JSON.stringify(value))
    }
    emit({ event: 'run', runId, version: 1, smallSample: true, cap, hardCap: HARD_CAP, alreadyReserved: { ...totals }, textModels, imageModels, rounds, verifier, stageTimeoutMs: stageTimeout, runTimeoutMs: runTimeout, baseline: { planningModel: baseline.planningModel, scriptModel: baseline.scriptModel, imageModel: baseline.imageModel, concurrency: baseline.concurrency }, mode: 'custom', fixtureHash: createHash('sha256').update(JSON.stringify(fixtures)).digest('hex'), imageWorkload: '18 identical pooled jobs per concurrency, 9 per model when both selected; 4/8/16; 2 shared-reference sheet candidates; 56 nominal images', semanticTextQuality: 'unknown: deterministic validation and quote checks only' })
    emit({ event: 'text-scheduling', concurrentCandidates: textModels.length, stagesPerCandidate: 'serial', isolatedModelLatency: false })
    const wrappedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const context = scope.getStore()
      if (!context) throw new Error('Unscoped network forbidden')
      const url = new URL(input instanceof Request ? input.url : String(input))
      const paths = [`${endpointUrl.pathname}/chat/completions`, `${endpointUrl.pathname}/images/generations`, `${endpointUrl.pathname}/images/edits`]
      if (url.origin !== endpointUrl.origin || !paths.includes(url.pathname) || url.search || url.hash) {
        context.controller.abort(new Error('Remote image downloads and other endpoints forbidden'))
        throw new Error('Unapproved network destination')
      }
      const kind: Kind = url.pathname.endsWith('/chat/completions') ? 'text' : 'image'
      const signal = AbortSignal.any([runController.signal, context.controller.signal, ...(init?.signal ? [init.signal] : [])])
      signal.throwIfAborted()
      if (totals[kind] >= Math.min(cap[kind], HARD_CAP[kind])) {
        context.controller.abort(new Error('Aggregate quota exhausted'))
        throw new Error('Aggregate quota exhausted')
      }
      const requestId = randomUUID()
      append(ledger!, { event: 'reserved', runId, requestId, kind, at: Date.now() })
      totals[kind]++
      context.attempts++
      const attempt = context.attempts
      const start = performance.now()
      emit({ event: 'request-start', id: context.id, requestId, stage: context.stage, model: context.model, attempt, kind, totals: { ...totals } })
      try {
        const response = await originalFetch(input, { ...init, signal, redirect: 'error' })
        const bytes = await response.arrayBuffer()
        let data: unknown
        try { data = JSON.parse(new TextDecoder().decode(bytes)) } catch { data = null }
        const json = kind === 'text' ? validJsonReply(data) : null
        if (json) context.jsonReplies++
        if (attempt === 1) context.firstJson = json
        const usage = data && typeof data === 'object' && 'usage' in data ? numericUsage(data.usage) : null
        emit({ event: 'request-end', id: context.id, requestId, stage: context.stage, model: context.model, attempt, kind, elapsedMs: Math.round(performance.now() - start), status: response.status, validJson: json, usage: usage ?? null })
        return new Response([204, 205, 304].includes(response.status) ? null : bytes, { status: response.status, statusText: response.statusText, headers: response.headers })
      } catch {
        emit({ event: 'request-end', id: context.id, requestId, stage: context.stage, model: context.model, attempt, kind, elapsedMs: Math.round(performance.now() - start), failure: signal.aborted ? 'aborted-or-timeout' : 'transport-error' })
        throw new Error('Benchmark transport failed')
      }
    }
    globalThis.fetch = wrappedFetch as typeof fetch

    async function stage<T>(stageName: string, model: string, fixture: string, round: number, concurrency: number, run: (signal: AbortSignal) => Promise<T>, inspect?: (value: T) => number): Promise<T | undefined> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('Stage deadline')), stageTimeout)
      const context: Context = { id: randomUUID(), stage: stageName, model, fixture, round, concurrency, attempts: 0, jsonReplies: 0, firstJson: null, controller }
      const start = performance.now()
      let value: T | undefined
      let failure: string | null = null
      let critical: number | null = null
      let success = false
      try {
        value = await scope.run(context, () => run(AbortSignal.any([controller.signal, runController.signal])))
        critical = inspect ? inspect(value) : null
        success = true
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        const rules = ['unknown character', 'unknown look', 'unknown place', 'unknown prop', 'dialogue', 'too short', 'text items', 'caption', 'invalid page', 'broken JSON', 'non-empty', 'coverage', 'source order']
        emit({ event: 'failure-detail', id: context.id, stage: stageName, model, errorType: error instanceof Error ? error.name : 'unknown', rules: rules.filter((rule) => message.includes(rule)) })
        const reason: unknown = controller.signal.reason
        failure = runController.signal.aborted ? 'run-timeout' : controller.signal.aborted
          ? reason instanceof Error && reason.message === 'Aggregate quota exhausted' ? 'quota-exhausted'
            : reason instanceof Error && reason.message === 'Stage deadline' ? 'stage-timeout' : 'blocked-network'
          : 'provider-or-validation-failure'
      } finally { clearTimeout(timer) }
      const elapsedMs = Math.round(performance.now() - start)
      const result: Result = { event: 'stage', id: context.id, stage: stageName, model, fixture, round, concurrency, elapsedMs, attempts: context.attempts, terminalSuccess: success, firstPassSuccess: success && context.attempts === 1, validJson: stageName === 'sheet' || stageName === 'panel' ? null : context.jsonReplies > 0, timeToValidOutputMs: success ? elapsedMs : null, quality: critical === null ? 'unknown' : critical ? 'failed' : 'passed', criticalFidelityFailures: critical, failure }
      results.push(result); emit(result)
      return value
    }

    for (let round = 0; round < rounds && !runController.signal.aborted; round++) {
      for (const fixture of fixtures) {
        await Promise.all([...textModels.slice(round % Math.max(textModels.length, 1)), ...textModels.slice(0, round % Math.max(textModels.length, 1))].map(async (model) => {
          if (totals.text >= cap.text || runController.signal.aborted) return
          const candidate = { ...settings, planningModel: model, scriptModel: model }
          await stage('plan', model, fixture.id, round, 1, (signal) => planBatch(candidate, adaptation, [{ ref: { index: 1, name: fixture.id, url: '' }, text: fixture.text }], [], undefined, 1, signal), (plan) => Number(plan.chapters.flatMap((chapter) => chapter.novelChapters.map((ref) => ref.index)).join(',') !== '1') + characters.filter((character) => !plan.characters.some((entry) => entry.name.toLowerCase() === character.name.toLowerCase())).length)
          await stage('beats', model, fixture.id, round, 1, (signal) => writeBeats(candidate, fixture.text, undefined, characters, fixture.input.places, signal), (reply) => validateBeats(reply, fixture.text).length + reply.cut.length)
          await stage('script', model, fixture.id, round, 1, (signal) => writeScript(candidate, fixture.input, signal), (pages) => {
            const spoken = pages.flatMap((page) => page.panels.flatMap((panel) => panel.text.map((item) => item.line))).join(' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ')
            const missing = fixture.input.beats.flatMap((beat) => beat.lines).filter(([, line]) => !spoken.includes(line.toLowerCase().replace(/[^a-z0-9]+/g, ' ')))
            return validateScript(pages, fixture.input).length + missing.length
          })
        }))
      }
    }

    const imageFiles = new Map<Blob, string>()
    async function saveImage(blob: Blob): Promise<void> {
      const bytes = Buffer.from(await blob.arrayBuffer())
      if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Expected PNG bytes')
      const file = `image-${randomUUID()}.png`
      writeFileSync(resolve(dirname(outputPath), file), bytes, { flag: 'wx', mode: 0o600 })
      imageFiles.set(blob, file)
      const width = bytes.readUInt32BE(16)
      const height = bytes.readUInt32BE(20)
      emit({ event: 'image', id: scope.getStore()?.id, file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, width, height, requestedWidth: 1536, requestedHeight: 1024, requestedSizeMatched: width === 1536 && height === 1024 })
    }
    const imagePart = async (blob: Blob): Promise<ContentPart> => {
      const bytes = Buffer.from(await blob.arrayBuffer())
      return { type: 'image_url', image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` } }
    }
    const qualityRows: { candidate: string; concurrency: number; failures: number | null }[] = []
    async function review(blob: Blob, refs: Blob[], prompt: string, candidate: string, fixture: string, concurrency: number): Promise<void> {
      if (verifier === 'none' || totals.text >= cap.text || runController.signal.aborted) {
        qualityRows.push({ candidate, concurrency, failures: null })
        emit({ event: 'review', file: imageFiles.get(blob), candidate, fixture, concurrency, quality: 'unknown', reason: verifier === 'none' ? 'checker-disabled' : 'budget-or-deadline' })
        return
      }
      const checked = await stage('verify', verifier, fixture, 0, concurrency, async (signal) => {
        const parts: ContentPart[] = [{ type: 'text', text: `Check the first image against this exact requirement: ${prompt}\nRemaining images are reference sheets. Check identity, clothing, count of people, key shape and hand ownership, required action, visible text or watermark, and empty top-left lettering space for panels. Return {"ok": boolean, "criticalFailures": string[]} using only these failure codes: identity, count, clothing, key, hands, action, lettering, text. Do not invent observations. If image cannot be inspected return {"unknown":true}.` }, await imagePart(blob)]
        for (const ref of refs) parts.push(await imagePart(ref))
        const reply = await chatJson<{ ok?: unknown; criticalFailures?: unknown; unknown?: unknown }>(settings, verifier, 'You are a strict visual fidelity verifier. Return one JSON object only.', parts, signal)
        if (reply.unknown === true) return null
        const allowed = ['identity', 'count', 'clothing', 'key', 'hands', 'action', 'lettering', 'text']
        if (typeof reply.ok !== 'boolean' || !Array.isArray(reply.criticalFailures) || !reply.criticalFailures.every((entry) => typeof entry === 'string' && allowed.includes(entry)) || reply.ok !== (reply.criticalFailures.length === 0)) throw new Error('Malformed checker reply')
        return reply.criticalFailures as string[]
      })
      qualityRows.push({ candidate, concurrency, failures: checked?.length ?? null })
      emit({ event: 'review', file: imageFiles.get(blob), candidate, verifier, fixture, concurrency, quality: checked == null ? 'unknown' : checked.length ? 'failed' : 'passed', criticalFidelityFailures: checked?.length ?? null, failureCodes: checked ?? null })
    }

    const sheets: { model: string; blob: Blob }[] = []
    for (const model of imageModels) {
      if (runController.signal.aborted || totals.image >= cap.image) break
      const blob = await stage('sheet', model, 'reference', 0, 1, async (signal) => {
        const image = await generateImage(settings, model, sheetPrompt, '1536x1024', signal)
        await saveImage(image)
        return image
      })
      if (blob) sheets.push({ model, blob })
    }
    const reference = sheets[0]?.blob
    emit({ event: 'reference', file: reference ? imageFiles.get(reference) : null, selection: 'first successful candidate in fixed model order; all panel candidates receive identical bytes', quality: 'unknown-until-review' })
    if (reference) {
      const reviews: { blob: Blob; model: string; prompt: string; fixture: string; concurrency: number }[] = []
      for (const concurrency of [4, 8, 16]) {
        if (runController.signal.aborted || totals.image >= cap.image) break
        const slots = createSlots()
        const batchStart = performance.now()
        let active = 0
        let peak = 0
        let attemptedJobs = 0
        let successfulJobs = 0
        const jobs = Array.from({ length: 18 }, (_, index) => ({ model: imageModels[index % imageModels.length], prompt: panelPrompts[Math.floor(index / imageModels.length) % panelPrompts.length], fixture: `panel-${Math.floor(index / imageModels.length) % panelPrompts.length}` }))
        await Promise.all(jobs.map((job, index) => slots(concurrency, 0, runController.signal, async () => {
          if (totals.image >= cap.image) return
          attemptedJobs++
          active++; peak = Math.max(peak, active)
          try {
            const blob = await stage('panel', job.model, job.fixture, Math.floor(index / (imageModels.length * panelPrompts.length)), concurrency, async (signal) => {
              const image = await editImage(settings, job.model, job.prompt, [reference], '1536x1024', signal)
              await saveImage(image)
              return image
            })
            if (blob) {
              successfulJobs++
              reviews.push({ blob, model: job.model, prompt: job.prompt, fixture: job.fixture, concurrency })
            }
          } finally { active-- }
        }).catch(() => undefined)))
        emit({ event: 'concurrency', concurrency, peakActiveStages: peak, offeredJobs: jobs.length, attemptedJobs, successfulJobs, workloadComplete: attemptedJobs === jobs.length, elapsedMs: Math.round(performance.now() - batchStart), mixedModelPool: true, sameOfferedWorkload: true })
      }
      const reviewSlots = createSlots()
      await Promise.all([
        ...sheets.map((sheet) => () => review(sheet.blob, [], sheetPrompt, sheet.model, 'reference', 1)),
        ...reviews.map((item) => () => review(item.blob, [reference], item.prompt, item.model, item.fixture, item.concurrency)),
      ].map((run) => reviewSlots(3, 0, runController.signal, run).catch(() => undefined)))
    } else if (imageModels.length) emit({ event: 'skipped', stage: 'panel', reason: 'no-local-reference-sheet', quality: 'unknown' })

    for (const candidate of imageModels) {
      for (const concurrency of [1, 4, 8, 16]) {
        const rows = qualityRows.filter((row) => row.candidate === candidate && row.concurrency === concurrency)
        if (!rows.length) continue
        const checked = rows.filter((row) => row.failures !== null)
        emit({ event: 'quality-summary', candidate, concurrency, samples: rows.length, smallSample: true, verified: checked.length, unknown: rows.length - checked.length, passed: checked.filter((row) => row.failures === 0).length, criticalFidelityFailures: checked.length ? checked.reduce((sum, row) => sum + row.failures!, 0) : null, verifier })
      }
    }

    const groups = new Map<string, Result[]>()
    for (const result of results) {
      const key = `${result.stage}:${result.model}:${result.concurrency}`
      groups.set(key, [...(groups.get(key) ?? []), result])
    }
    for (const [group, rows] of groups) {
      const times = rows.map((row) => row.elapsedMs).sort((a, b) => a - b)
      const validTimes = rows.flatMap((row) => row.timeToValidOutputMs === null ? [] : [row.timeToValidOutputMs]).sort((a, b) => a - b)
      const median = (values: number[]) => values.length ? (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2 : null
      emit({ event: 'summary', group, samples: rows.length, smallSample: true, medianMs: median(times), worstObservedMs: times.at(-1), medianTimeToValidOutputMs: median(validTimes), firstPassSuccessRate: rows.filter((row) => row.firstPassSuccess).length / rows.length, terminalSuccessRate: rows.filter((row) => row.terminalSuccess).length / rows.length, validJsonRate: rows.every((row) => row.validJson === null) ? null : rows.filter((row) => row.validJson).length / rows.length, criticalFidelityFailures: rows.some((row) => row.criticalFidelityFailures !== null) ? rows.reduce((sum, row) => sum + (row.criticalFidelityFailures ?? 0), 0) : null, qualityUnknown: rows.filter((row) => row.quality === 'unknown').length })
    }
    emit({ event: 'complete', totals, runDeadlineReached: runController.signal.aborted, qualityCaution: 'HTTP success is not fidelity. Review rows carry image quality. Structural text checks are not semantic verification. Pooled concurrency is not isolated per-model throughput. Small sample, no percentile claims.' })
    console.log(JSON.stringify({ event: 'complete', output: relative(ROOT, outputPath), totals, smallSample: true }))
  } finally {
    clearTimeout(runTimer)
    globalThis.fetch = originalFetch
    if (output !== undefined) closeSync(output)
    if (ledger !== undefined) closeSync(ledger)
    closeSync(lock)
    unlinkSync(lockPath)
  }
}

main().catch((error: unknown) => {
  if (process.argv.includes('--offline')) console.error(error instanceof Error ? error.message : 'Offline assertion failed')
  else console.error('Benchmark stopped. Check options, unique .tmp output, ledger integrity/lock. No provider error bodies or credentials are printed.')
  process.exitCode = 1
})
