import { holdInputs, journalStore, recoverInterrupted } from './store'
import { JOURNAL_SCHEMA_VERSION, hashBlob, splitValidation } from './helpers'
import { initializeRecording } from './files'
import { hasJournalStorage } from './capabilities'
import type { GenerationRecord, GenerationStage, JournalEvent, JournalOptions, JournalPath, JournalRequest, JournalStore, JsonObject, JsonValue } from './types'

const captures = new Map<string, JournalCapture>()
let ownerIdValue: string | undefined
function ownerId(): string {
  ownerIdValue ??= `${typeof window === 'undefined' ? 'node' : 'browser'}:${crypto.randomUUID()}`
  return ownerIdValue
}
let recovery: Promise<void> | undefined
/** A key this short also matches ordinary words, and redacting those corrupts the saved prompt and output. */
const MIN_REDACTED_SECRET_CHARS = 8

/** Unsafe keys are dropped and non-finite numbers become null, as `JSON.stringify` would write them. */
export function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(jsonValue)
  if (typeof value === 'object') {
    const result: JsonObject = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined && !['__proto__', 'prototype', 'constructor'].includes(key)) result[key] = jsonValue(entry)
    }
    return result
  }
  throw new Error('Generation data cannot be recorded as JSON.')
}

function redact(value: string, secret: string): string {
  return secret.length >= MIN_REDACTED_SECRET_CHARS ? value.split(secret).join('[redacted]') : value
}

export class JournalCapture {
  readonly run: GenerationRecord
  private sequence = 0
  private release?: () => void
  private releaseInputs?: () => void
  readonly store: JournalStore
  private secret: string

  constructor(store: JournalStore, model: string, endpoint: string, secret: string, stage: GenerationStage, options?: JournalOptions) {
    this.store = store
    this.secret = secret
    const now = Date.now()
    const url = new URL(endpoint)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    this.run = {
      ...options?.context,
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      id: options?.replayId ?? crypto.randomUUID(),
      stage: options?.context?.stage ?? stage,
      model,
      endpoint: url.toString().replace(/\/$/, ''),
      status: 'running',
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      ownerId: ownerId(),
    }
    if (this.run.validation !== undefined) this.run.validation = this.sanitize(this.run.validation)
  }

  async start(): Promise<void> {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      let enter!: () => void
      let reject!: (reason: unknown) => void
      const entered = new Promise<void>((resolve, fail) => { enter = resolve; reject = fail })
      const held = new Promise<void>((resolve) => { this.release = resolve })
      void navigator.locks.request(`kagi-generation:${this.run.id}`, async () => {
        enter()
        await held
      }).catch(reject)
      await entered
    }
    captures.set(this.run.id, this)
    try {
      await this.storeInputs()
      await this.event('started')
    } catch (error) {
      this.close()
      throw error
    }
  }

  private async storeInputs(): Promise<void> {
    if (this.run.inputs) {
      this.releaseInputs = holdInputs(this.run.inputs)
      return
    }
    const split = await splitValidation(this.run.validation)
    if (!split.inputs) return
    this.run.validation = split.validation
    this.run.inputs = split.inputs
    this.releaseInputs = holdInputs(split.inputs)
    for (const artifact of split.artifacts) if (!await this.store.getArtifact(artifact.id)) await this.store.putArtifact(artifact)
  }

  async save(): Promise<void> {
    this.run.updatedAt = Math.max(Date.now(), this.run.updatedAt + 1)
    await this.store.putRun(this.run)
  }

  sanitize(value: JsonValue): JsonValue {
    if (typeof value === 'string') return redact(value, this.secret)
    if (Array.isArray(value)) return value.map((entry) => this.sanitize(entry))
    if (value !== null && typeof value === 'object') {
      const result: JsonObject = {}
      for (const [key, entry] of Object.entries(value)) result[key] = this.sanitize(entry)
      return result
    }
    return value
  }

  async event(kind: JournalEvent['kind'], details: Omit<JournalEvent, 'id' | 'generationId' | 'sequence' | 'at' | 'kind'> = {}): Promise<void> {
    await this.store.putEvent({ ...details, id: crypto.randomUUID(), generationId: this.run.id, sequence: this.sequence++, at: Date.now(), kind })
  }

  async artifact(blob: Blob, name: string): Promise<string> {
    const id = crypto.randomUUID()
    await this.store.putArtifact({ id, generationId: this.run.id, name, mime: blob.type || 'application/octet-stream', size: blob.size, sha256: await hashBlob(blob), blob })
    return id
  }

  private async archiveJson(value: JsonValue): Promise<JsonValue> {
    if (typeof value === 'string') {
      const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(value)
      if (!match) return redact(value, this.secret)
      const bytes = Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0))
      const id = await this.artifact(new Blob([bytes], { type: match[1] }), `reference-${crypto.randomUUID()}.bin`)
      return `journal-artifact:${id}`
    }
    if (Array.isArray(value)) return Promise.all(value.map((entry) => this.archiveJson(entry)))
    if (value !== null && typeof value === 'object') {
      const result: JsonObject = {}
      for (const [key, entry] of Object.entries(value)) result[key] = await this.archiveJson(entry)
      return result
    }
    return value
  }

  async prepare(path: JournalPath, body: RequestInit['body']): Promise<void> {
    let request: JournalRequest
    if (typeof body === 'string') {
      const parsed = jsonValue(JSON.parse(body))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid model request body.')
      const archived = await this.archiveJson(parsed)
      if (archived === null || typeof archived !== 'object' || Array.isArray(archived)) throw new Error('Invalid archived request body.')
      request = { path, kind: 'json', body: archived }
    } else if (body instanceof FormData) {
      const entries: Extract<JournalRequest, { kind: 'form' }>['entries'] = []
      const fields: Iterable<[string, FormDataEntryValue]> = body.entries()
      for (const [name, value] of fields) {
        if (typeof value === 'string') entries.push({ name, value: redact(value, this.secret) })
        else entries.push({ name, filename: value.name, artifactId: await this.artifact(value, `reference-${crypto.randomUUID()}.bin`) })
      }
      request = { path, kind: 'form', entries }
    } else throw new Error('This model request cannot be recorded.')
    this.run.request = request
  }

  async attempt(attempt: number, reason?: string): Promise<void> {
    this.run.attempts = attempt
    await this.event('request', { attempt, message: reason })
    await this.save()
  }

  async response(attempt: number, status: number, body: string): Promise<void> {
    const artifactId = await this.artifact(new Blob([redact(body, this.secret)], { type: 'text/plain' }), `response-${attempt}.txt`)
    await this.event('response', { attempt, status, artifactId })
  }

  async transportError(attempt: number, cause: unknown): Promise<void> {
    const message = cause instanceof Error ? cause.message : String(cause)
    await this.event('transport-error', { attempt, message: redact(message, this.secret) })
  }

  async finish(output: JsonValue | undefined, image?: Blob): Promise<void> {
    try {
      if (output !== undefined) this.run.output = this.sanitize(output)
      if (image) {
        this.run.outputArtifactId = await this.artifact(image, 'output.png')
        const saved = this.run.output
        if (saved && typeof saved === 'object' && !Array.isArray(saved) && Array.isArray(saved.data)) {
          saved.data = saved.data.map((entry, index) => index === 0 && entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.b64_json === 'string'
            ? { ...entry, b64_json: `journal-artifact:${this.run.outputArtifactId}` }
            : entry)
        }
      }
      if (this.run.validation === undefined) {
        this.run.status = 'succeeded'
        this.run.finishedAt = Date.now()
        await this.event('completed')
      }
      // A run awaiting validation is saved by recordValidation next, with this output.
      if (image || this.run.status !== 'running') await this.save()
    } catch (error) {
      this.close()
      throw error
    }
    if (this.run.status !== 'running') this.close()
  }

  async fail(cause: unknown, signal?: AbortSignal): Promise<void> {
    try {
      this.run.status = signal?.aborted ? 'cancelled' : 'failed'
      this.run.error = redact(cause instanceof Error ? cause.message : String(cause), this.secret)
      this.run.finishedAt = Date.now()
      await this.event('completed', { message: this.run.error })
      await this.save()
    } finally { this.close() }
  }

  close(): void {
    captures.delete(this.run.id)
    this.release?.()
    this.release = undefined
    this.releaseInputs?.()
    this.releaseInputs = undefined
  }
}

export async function beginGeneration(model: string, connection: { endpoint: string; apiKey: string }, stage: GenerationStage, options?: JournalOptions): Promise<JournalCapture | undefined> {
  const store = options?.store ?? (hasJournalStorage() ? journalStore : undefined)
  if (!store) return undefined
  if (store === journalStore && typeof window !== 'undefined') {
    await initializeRecording().catch(() => undefined)
    recovery ??= recoverInterrupted(store)
    await recovery
  }
  const capture = new JournalCapture(store, model, connection.endpoint, connection.apiKey, stage, options)
  await capture.start()
  options?.onRecord?.(capture.run.id)
  return capture
}

export async function recordValidation(id: string, errors: readonly string[], output?: JsonValue, store: JournalStore = journalStore): Promise<void> {
  const capture = captures.get(id)
  const targetStore = capture?.store ?? store
  const run = capture?.run ?? await targetStore.getRun(id)
  if (!run) throw new Error('The generation record is missing.')
  try {
    const now = Date.now()
    const message = capture ? String(capture.sanitize(errors.join('\n'))) : errors.join('\n')
    if (capture) await capture.event('validation', { message, data: { valid: errors.length === 0 } })
    else {
      const events = await targetStore.getEvents(id)
      await targetStore.putEvent({ id: crypto.randomUUID(), generationId: id, sequence: Math.max(-1, ...events.map((event) => event.sequence)) + 1, at: now, kind: 'validation', message, data: { valid: errors.length === 0 } })
    }
    run.status = errors.length ? 'failed' : 'succeeded'
    run.error = errors.length ? message : undefined
    run.finishedAt = now
    run.updatedAt = Math.max(now, run.updatedAt + 1)
    if (output !== undefined) run.output = capture ? capture.sanitize(output) : output
    await targetStore.putRun(run)
  } finally { capture?.close() }
}
