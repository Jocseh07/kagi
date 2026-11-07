import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chatJson, generateImage } from '../src/lib/adapt/client'
import { createFileJournal } from '../desktop/src/journal-store'
import { getBundle, recoverInterrupted } from '../src/lib/adapt/journal/store'
import { adaptationRunIds, canonicalJson, hashBlob, importBundle, resolveValidation, validateBundle } from '../src/lib/adapt/journal/helpers'
import { recordValidation } from '../src/lib/adapt/journal/runtime'
import { replayGeneration } from '../src/lib/adapt/journal/replay'
import type { GenerationRecord, JournalStore } from '../src/lib/adapt/journal/types'

import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js'
import { importJournal } from '../src/lib/adapt/journal/files'
let directory: string
let store: JournalStore
const originalFetch = globalThis.fetch
const connection = { endpoint: 'http://127.0.0.1:8317/v1', apiKey: 'fixture-private-key' }

beforeEach(async () => {
  directory = await mkdtemp(resolve('.tmp/journal-test-'))
  store = await createFileJournal(directory)
})
afterEach(async () => {
  globalThis.fetch = originalFetch
  await rm(directory, { recursive: true, force: true })
})

function reply(value: unknown): Response {
  return Response.json({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] })
}
function record(): GenerationRecord {
  const now = Date.now()
  return { schemaVersion: 1, id: crypto.randomUUID(), stage: 'prompt', model: 'fixture-model', endpoint: connection.endpoint, status: 'running', createdAt: now, updatedAt: now, attempts: 0, ownerId: 'node:fixture', validation: {} }
}

describe('generation journal', () => {
  test('stores image bytes separately from normalized output', async () => {
    const encoded = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    globalThis.fetch = (async () => Response.json({ data: [{ b64_json: encoded }] })) as typeof fetch
    const image = await generateImage(connection, 'model', 'scene', '1024x1024', undefined, { store })
    const run = (await store.listRuns())[0]
    expect(run.status).toBe('succeeded')
    expect(run.output).toEqual({ data: [{ b64_json: `journal-artifact:${run.outputArtifactId}` }] })
    const artifact = await store.getArtifact(run.outputArtifactId!)
    expect(await artifact?.blob.arrayBuffer()).toEqual(await image.arrayBuffer())
    await validateBundle(await getBundle(store, run.id))
  })

  test('rejects unsafe ZIP paths and changed artifact bytes before import', async () => {
    const unsafe = new ZipWriter(new BlobWriter(), { useWebWorkers: false })
    await unsafe.add('../outside.json', new TextReader('{}'))
    await expect(importJournal(new File([await unsafe.close()], 'unsafe.zip'))).rejects.toThrow()
    const run = record()
    const id = crypto.randomUUID()
    const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false })
    await writer.add(`${run.id}/manifest.json`, new TextReader(JSON.stringify(run)))
    await writer.add(`${run.id}/events.jsonl`, new TextReader(''))
    await writer.add(`${run.id}/artifacts/${id}.json`, new TextReader(JSON.stringify({ id, generationId: run.id, name: 'output.txt', mime: 'text/plain', size: 3, sha256: '0'.repeat(64) })))
    await writer.add(`${run.id}/artifacts/${id}.bin`, new TextReader('bad'))
    await expect(importJournal(new File([await writer.close()], 'changed.zip'))).rejects.toThrow('changed')
  })

  test('preserves malformed raw responses without credentials and records semantic failures', async () => {
    globalThis.fetch = (async () => new Response(`broken ${connection.apiKey}`)) as typeof fetch
    await expect(chatJson(connection, 'model', 'system', 'input', undefined, { store, maxAttempts: 1, context: { stage: 'prompt', validation: {} } })).rejects.toThrow('unreadable JSON')
    const malformed = (await store.listRuns())[0]
    expect(malformed.status).toBe('failed')
    const bundle = await getBundle(store, malformed.id)
    await validateBundle(bundle)
    expect(await bundle.artifacts[0].blob.text()).toBe('broken [redacted]')
    expect(JSON.stringify(bundle)).not.toContain(connection.apiKey)
    globalThis.fetch = (async () => reply({ prompt: '' })) as typeof fetch
    let id = ''
    await chatJson(connection, 'model', 'system', 'input', undefined, { store, context: { stage: 'prompt', validation: {} }, onRecord: (value) => { id = value } })
    expect((await store.getRun(id))?.status).toBe('running')
    await recordValidation(id, ['The prompt is empty.'], undefined, store)
    expect((await store.getRun(id))?.error).toBe('The prompt is empty.')
    expect((await store.getRun(id))?.status).toBe('failed')
  })

  test('replays one saved request, keeps its boundary, and never overwrites the original', async () => {
    globalThis.fetch = (async () => reply({ prompt: '' })) as typeof fetch
    let id = ''
    const operationId = crypto.randomUUID()
    await chatJson(connection, 'model', 'system', 'original input', undefined, { store, context: { stage: 'prompt', validation: {}, operationId }, onRecord: (value) => { id = value } })
    await recordValidation(id, ['Invalid prompt'], undefined, store)
    const before = await store.getRun(id)
    let calls = 0
    globalThis.fetch = (async (_url, init) => {
      calls++
      expect(JSON.parse(String(init?.body)).messages[1].content).toBe('original input')
      return reply({ prompt: 'Repaired scene' })
    }) as typeof fetch
    const replay = await replayGeneration(store, id, connection)
    expect(calls).toBe(1)
    expect(replay.status).toBe('succeeded')
    expect(replay.parentId).toBe(id)
    expect(replay.operationId).toBe(operationId)
    expect(replay.output).toEqual({ journalValidated: 1, raw: { prompt: 'Repaired scene' }, value: 'Repaired scene' })
    expect(await store.getRun(id)).toEqual(before)
    expect(replay.appliedAt).toBeUndefined()
    await validateBundle(await getBundle(store, replay.id))
  })

  test('default replay budget stops after one failed provider request', async () => {
    const original = { ...record(), request: { kind: 'json' as const, path: '/chat/completions' as const, body: { model: 'model', messages: [{ role: 'user', content: 'input' }] } } }
    await store.putRun(original)
    let calls = 0
    globalThis.fetch = (async () => { calls++; return new Response('outage', { status: 503 }) }) as typeof fetch
    const replay = await replayGeneration(store, original.id, connection)
    expect(calls).toBe(1)
    expect(replay.status).toBe('failed')
    expect(replay.attempts).toBe(1)
    await expect(replayGeneration(store, original.id, { ...connection, maxRequests: 7 })).rejects.toThrow('1 to 6')
    expect(calls).toBe(1)
  })

  test('retains a failed image download body instead of reporting a successful generation', async () => {
    let calls = 0
    globalThis.fetch = (async () => ++calls === 1 ? Response.json({ data: [{ url: 'http://127.0.0.1/image.png' }] }) : new Response('expired image', { status: 410 })) as typeof fetch
    await expect(generateImage(connection, 'model', 'scene', '1024x1024', undefined, { store })).rejects.toThrow('could not be downloaded')
    const run = (await store.listRuns())[0]
    expect(run.status).toBe('failed')
    const bundle = await getBundle(store, run.id)
    const event = bundle.events.find((entry) => entry.status === 410)
    expect(await bundle.artifacts.find((artifact) => artifact.id === event?.artifactId)?.blob.text()).toBe('expired image')
  })

  test('allows request initialization once and rejects later identity changes', async () => {
    const initial = record()
    await store.putRun(initial)
    const populated = { ...initial, updatedAt: initial.updatedAt + 1, request: { kind: 'json' as const, path: '/chat/completions' as const, body: { messages: [] } } }
    await importBundle(store, { run: populated, events: [], artifacts: [] })
    expect((await store.getRun(initial.id))?.request).toEqual(populated.request)
    await expect(importBundle(store, { run: { ...populated, updatedAt: populated.updatedAt + 1, request: { ...populated.request, body: { messages: ['changed'] } } }, events: [], artifacts: [] })).rejects.toThrow('different generation')
    await expect(importBundle(store, { run: { ...populated, operationId: 'other' }, events: [], artifacts: [] })).rejects.toThrow('different generation')
  })

  test('file events serialize conflicts and artifacts reject corruption and unsafe names', async () => {
    const run = record()
    await store.putRun(run)
    const event = { id: crypto.randomUUID(), generationId: run.id, sequence: 0, at: Date.now(), kind: 'started' as const }
    const results = await Promise.allSettled([store.putEvent(event), store.putEvent({ ...event, id: crypto.randomUUID() })])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const blob = new Blob(['evidence'], { type: 'text/plain' })
    const artifact = { id: crypto.randomUUID(), generationId: run.id, name: 'evidence.txt', mime: blob.type, size: blob.size, sha256: await hashBlob(blob), blob }
    await store.putArtifact(artifact)
    expect((await stat(resolve(directory, run.id, 'manifest.json'))).mode & 0o777).toBe(0o600)
    await expect(validateBundle({ run, events: [], artifacts: [{ ...artifact, blob: new Blob(['modified']) }] })).rejects.toThrow('changed')
    await expect(validateBundle({ run, events: [], artifacts: [{ ...artifact, name: '../outside' }] })).rejects.toThrow('unsafe')
    await expect(store.getRun('../outside')).rejects.toThrow('Invalid generation')
    expect(await (await store.getArtifact(artifact.id))?.blob.text()).toBe('evidence')
  })

  test('recovery preserves active foreign runs and marks abandoned work interrupted', async () => {
    const active = record()
    const abandoned = { ...record(), updatedAt: Date.now() - 3_600_001 }
    await store.putRun(active)
    await store.putRun(abandoned)
    await recoverInterrupted(store)
    expect((await store.getRun(active.id))?.status).toBe('running')
    expect((await store.getRun(abandoned.id))?.status).toBe('interrupted')
    expect((await store.getEvents(abandoned.id)).map((event) => event.kind)).toEqual(['interrupted'])
  })

  test('imports version 1 bundles as version 2 with shared inputs, round-trips them, and collects unshared inputs on deletion', async () => {
    const passage = 'The lantern swung over the quay. '.repeat(200)
    const cast = Array.from({ length: 30 }, (_, index) => ({ id: `c${index}`, name: `Sailor ${index}`, appearance: 'A tall sailor in a grey coat.' }))
    const request = { kind: 'json' as const, path: '/chat/completions' as const, body: { model: 'fixture-model', messages: [{ role: 'user', content: passage }] } }
    const first = { ...record(), status: 'failed' as const, request, validation: { prompt: passage, cast, span: { from: 0, to: 40 } } }
    const second = { ...record(), status: 'failed' as const, request, validation: { prompt: passage, span: { from: 40, to: 80 } } }
    await importBundle(store, { run: first, events: [], artifacts: [] })
    await importBundle(store, { run: second, events: [], artifacts: [] })

    const saved = (await store.getRun(first.id))!
    const other = (await store.getRun(second.id))!
    expect(saved.schemaVersion).toBe(2)
    expect(saved.validation).toEqual({ span: { from: 0, to: 40 } })
    expect(JSON.stringify(saved).length).toBeLessThan(JSON.stringify(first).length - passage.length)
    expect(canonicalJson(await resolveValidation(store, saved))).toBe(canonicalJson(first.validation))
    const shared = saved.inputs!.filter((id) => other.inputs!.includes(id))
    expect(shared).toHaveLength(1)

    await importBundle(store, { run: first, events: [], artifacts: [] })
    const bundle = await getBundle(store, first.id)
    await validateBundle(bundle)
    const copy = await mkdtemp(resolve('.tmp/journal-test-'))
    try {
      const fresh = await createFileJournal(copy)
      await importBundle(fresh, bundle)
      expect(canonicalJson(await resolveValidation(fresh, (await fresh.getRun(first.id))!))).toBe(canonicalJson(first.validation))
    } finally { await rm(copy, { recursive: true, force: true }) }

    globalThis.fetch = (async () => reply({ prompt: 'Lantern on the quay' })) as typeof fetch
    const replay = await replayGeneration(store, first.id, connection)
    expect(replay.status).toBe('succeeded')
    expect(replay.inputs).toEqual(saved.inputs)

    const own = saved.inputs!.filter((id) => !shared.includes(id))
    await store.deleteRun(first.id)
    expect(await store.getArtifact(shared[0])).toBeDefined()
    expect(await store.getArtifact(own[0])).toBeDefined()
    await store.deleteRun(replay.id)
    expect(await store.getArtifact(own[0])).toBeUndefined()
    await store.deleteRun(second.id)
    expect(await store.getArtifact(shared[0])).toBeUndefined()
  })

  test('deleting an adaptation removes its runs, events and artifacts and keeps an input another adaptation still uses', async () => {
    const passage = 'The lantern swung over the quay. '.repeat(200)
    const cast = Array.from({ length: 30 }, (_, index) => ({ id: `c${index}`, name: `Sailor ${index}`, appearance: 'A tall sailor in a grey coat.' }))
    const request = { kind: 'json' as const, path: '/chat/completions' as const, body: { model: 'fixture-model', messages: [{ role: 'user', content: 'scene' }] } }
    const run = (adaptationId: string, validation: GenerationRecord['validation']) => ({ ...record(), status: 'failed' as const, request, target: { adaptationId, title: adaptationId }, validation })
    const first = run('harbor', { prompt: passage, cast })
    const retry = run('harbor', { cast })
    const other = run('lighthouse', { prompt: passage })
    for (const item of [first, retry]) {
      const blob = new Blob(['{"prompt":"Lantern"}'], { type: 'application/json' })
      const artifact = { id: crypto.randomUUID(), generationId: item.id, name: 'output.json', mime: blob.type, size: blob.size, sha256: await hashBlob(blob), blob }
      const event = { id: crypto.randomUUID(), generationId: item.id, sequence: 0, at: Date.now(), kind: 'completed' as const, artifactId: artifact.id }
      await importBundle(store, { run: item, events: [event], artifacts: [artifact] })
    }
    await importBundle(store, { run: other, events: [], artifacts: [] })
    const saved = (await store.getRun(first.id))!
    const kept = (await store.getRun(other.id))!
    const sharedPrompt = saved.inputs!.find((id) => kept.inputs!.includes(id))!
    const harborOnly = saved.inputs!.find((id) => id !== sharedPrompt)!

    const ids = await adaptationRunIds(store, 'harbor')
    expect(ids.sort()).toEqual([first.id, retry.id].sort())
    for (const id of ids) await store.deleteRun(id)

    for (const id of ids) {
      expect(await store.getRun(id)).toBeUndefined()
      expect(await store.getEvents(id)).toEqual([])
      expect(await store.getArtifacts(id)).toEqual([])
    }
    expect(await store.getArtifact(harborOnly)).toBeUndefined()
    expect(await store.getArtifact(sharedPrompt)).toBeDefined()
    expect(canonicalJson(await resolveValidation(store, (await store.getRun(other.id))!))).toBe(canonicalJson(other.validation))
  })

  test('version 1 request events lose request copies on import, keep differing attempts, and re-import unchanged', async () => {
    const request = { kind: 'json' as const, path: '/chat/completions' as const, body: { model: 'fixture-model', messages: [{ role: 'user', content: 'first' }] } }
    const changed = { ...request, body: { ...request.body, messages: [{ role: 'user', content: 'second' }] } }
    const run = { ...record(), status: 'failed' as const, request }
    const event = (sequence: number, data?: typeof request) => ({ id: crypto.randomUUID(), generationId: run.id, sequence, at: Date.now(), kind: 'request' as const, attempt: sequence + 1, ...(data ? { data } : {}) })
    const events = [event(0, request), event(1, changed), event(2)]
    await importBundle(store, { run, events, artifacts: [] })

    const saved = await store.getEvents(run.id)
    expect(saved.map((item) => item.data)).toEqual([undefined, changed, undefined])
    await importBundle(store, { run, events, artifacts: [] })
    expect(await store.getEvents(run.id)).toEqual(saved)

    let sent: unknown
    globalThis.fetch = (async (_url: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return reply({ prompt: 'ok' }) }) as typeof fetch
    await replayGeneration(store, run.id, { ...connection, attempt: 1 })
    expect(sent).toMatchObject({ messages: [{ content: 'first' }] })
    await replayGeneration(store, run.id, { ...connection, attempt: 2 })
    expect(sent).toMatchObject({ messages: [{ content: 'second' }] })
  })
})
