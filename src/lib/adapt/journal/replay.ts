import { executeGenerationRequest } from '../client'
import { jsonValue, recordValidation } from './runtime'
import { assertGenerationRecord, resolveValidation } from './helpers'
import { validateReplayOutput } from './validation'
import type { GenerationRecord, JournalStore, JsonObject, JsonValue, ReplayOptions } from './types'

async function restoreReferences(value: JsonValue, store: JournalStore, generationId: string): Promise<JsonValue> {
  if (typeof value === 'string' && value.startsWith('journal-artifact:')) {
    const artifact = await store.getArtifact(value.slice(17))
    if (!artifact || artifact.generationId !== generationId) throw new Error('A saved reference image is missing.')
    const bytes = new Uint8Array(await artifact.blob.arrayBuffer())
    let binary = ''
    for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
    return `data:${artifact.mime};base64,${btoa(binary)}`
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => restoreReferences(item, store, generationId)))
  if (value !== null && typeof value === 'object') {
    const result: JsonObject = {}
    for (const [key, item] of Object.entries(value)) result[key] = await restoreReferences(item, store, generationId)
    return result
  }
  return value
}

export async function replayGeneration(store: JournalStore, id: string, options: ReplayOptions): Promise<GenerationRecord> {
  const original = await store.getRun(id)
  if (!original?.request) throw new Error('This generation has no saved request to replay.')
  const endpoint = new URL(options.endpoint)
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Choose an HTTP endpoint without credentials, query parameters, or a fragment.')
  }
  const maxRequests = options.maxRequests ?? 1
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 6) throw new Error('Choose a request limit from 1 to 6.')
  options.signal?.throwIfAborted()
  let request = original.request
  if (options.attempt !== undefined) {
    if (!Number.isInteger(options.attempt) || options.attempt < 1) throw new Error('Choose a recorded attempt number.')
    const event = (await store.getEvents(id)).find((entry) => entry.kind === 'request' && entry.attempt === options.attempt)
    if (!event) throw new Error('The selected attempt does not exist.')
    if (event.data) {
      const selected: unknown = { ...original, request: event.data }
      assertGenerationRecord(selected)
      if (!selected.request || selected.request.path !== original.request.path) throw new Error('The selected attempt has invalid request data.')
      request = selected.request
    }
  }
  const model = options.model?.trim() || original.model
  let init: RequestInit
  if (request.kind === 'json') {
    const restored = await restoreReferences(request.body, store, id)
    if (restored === null || typeof restored !== 'object' || Array.isArray(restored)) throw new Error('Invalid saved request.')
    restored.model = model
    if (options.prompt !== undefined) {
      if (request.path === '/chat/completions') {
        if (!Array.isArray(restored.messages)) throw new Error('The saved chat messages are missing.')
        let replaced = false
        restored.messages = restored.messages.map((message) => {
          if (message === null || typeof message !== 'object' || Array.isArray(message) || message.role !== 'user') return message
          replaced = true
          if (Array.isArray(message.content)) {
            const images = message.content.filter((part) => part !== null && typeof part === 'object' && !Array.isArray(part) && part.type === 'image_url')
            return { ...message, content: [{ type: 'text', text: options.prompt ?? '' }, ...images] }
          }
          return { ...message, content: options.prompt ?? '' }
        })
        if (!replaced) throw new Error('The saved request has no user prompt to replace.')
      } else restored.prompt = options.prompt
    }
    init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(restored) }
  } else {
    const form = new FormData()
    for (const entry of request.entries) {
      if ('value' in entry) form.append(entry.name, entry.name === 'model' ? model : entry.name === 'prompt' && options.prompt !== undefined ? options.prompt : entry.value)
      else {
        const artifact = await store.getArtifact(entry.artifactId)
        if (!artifact || artifact.generationId !== id) throw new Error('A saved reference image is missing.')
        form.append(entry.name, artifact.blob, entry.filename)
      }
    }
    form.set('model', model)
    if (options.prompt !== undefined) form.set('prompt', options.prompt)
    init = { method: 'POST', body: form }
  }
  const replayId = crypto.randomUUID()
  try {
    const result = await executeGenerationRequest({ endpoint: endpoint.toString().replace(/\/$/, ''), apiKey: options.apiKey }, model, request.path, init, options.signal, {
      replayId,
      store,
      maxAttempts: maxRequests,
      context: {
        stage: original.stage,
        target: original.target,
        operationId: original.operationId,
        parentId: original.id,
        validation: original.validation,
        inputs: original.inputs,
      },
    })
    const run = await store.getRun(replayId)
    if (!run) throw new Error('The replay result was not saved.')
    const output = validateReplayOutput(run.output === undefined ? { ...run, output: result.output } : run, await resolveValidation(store, run))
    await recordValidation(replayId, [], jsonValue(output), store)
  } catch (error) {
    const failed = await store.getRun(replayId)
    if (!failed) throw error
    if (failed.status === 'running' || failed.status === 'succeeded') {
      await recordValidation(replayId, [error instanceof Error ? error.message : String(error)], undefined, store)
    }
  }
  const result = await store.getRun(replayId)
  if (!result) throw new Error('The replay result was not saved.')
  return result
}
