import type { GenerationRecord, GenerationSummary, JournalArtifact, JournalBundle, JournalEvent, JournalStore, JsonObject, JsonValue } from './types'
export const JOURNAL_SCHEMA_VERSION = 2
const INLINE_INPUT_CHARS = 1024
const INPUT_NAME = 'input.json'
export async function hashBlob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function inputArtifactId(sha256: string): string {
  return `${sha256.slice(0, 8)}-${sha256.slice(8, 12)}-${sha256.slice(12, 16)}-${sha256.slice(16, 20)}-${sha256.slice(20, 32)}`
}

/** A shared input owns itself: its ID derives from its hash and it belongs to no single run. */
export function isInputArtifact(artifact: Pick<JournalArtifact, 'id' | 'generationId' | 'sha256'>): boolean {
  return artifact.generationId === artifact.id && /^[a-f0-9]{64}$/.test(artifact.sha256) && artifact.id === inputArtifactId(artifact.sha256)
}

async function inputArtifact(text: string): Promise<JournalArtifact> {
  const blob = new Blob([text], { type: 'application/json' })
  const sha256 = await hashBlob(blob)
  const id = inputArtifactId(sha256)
  return { id, generationId: id, name: INPUT_NAME, mime: 'application/json', size: blob.size, sha256, blob }
}

/** Moves each long validation field into a shared input artifact, so saving a run never rewrites it. */
export async function splitValidation(validation: JsonValue | undefined): Promise<{ validation?: JsonValue; inputs?: string[]; artifacts: JournalArtifact[] }> {
  if (!object(validation)) return { validation, artifacts: [] }
  const inline: JsonObject = {}
  const artifacts: JournalArtifact[] = []
  for (const [key, value] of Object.entries(validation)) {
    const text = JSON.stringify({ [key]: value })
    if (text.length > INLINE_INPUT_CHARS) artifacts.push(await inputArtifact(text))
    else inline[key] = value
  }
  return artifacts.length ? { validation: inline, inputs: artifacts.map((artifact) => artifact.id), artifacts } : { validation, artifacts }
}

export async function resolveValidation(store: JournalStore, run: Pick<GenerationRecord, 'validation' | 'inputs'>): Promise<JsonValue | undefined> {
  if (!run.inputs?.length) return run.validation
  const resolved: JsonObject = object(run.validation) ? { ...run.validation } : {}
  for (const id of run.inputs) {
    const artifact = await store.getArtifact(id)
    if (!artifact || !isInputArtifact(artifact)) throw new Error('A saved validation input is missing.')
    const fields: unknown = JSON.parse(await artifact.blob.text())
    if (!object(fields) || !json(fields)) throw new Error('A saved validation input is invalid.')
    Object.assign(resolved, fields)
  }
  return resolved
}

/** JSON with sorted keys, so a resolved validation compares equal however its fields were split. */
export function canonicalJson(value: JsonValue | undefined): string {
  return JSON.stringify(value ?? null, (_key, item: unknown) => object(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    : item)
}

/** A version 1 record as version 2, with the shared inputs it now refers to; a version 2 record is returned as is. */
export async function upgradeRecord(run: GenerationRecord): Promise<{ run: GenerationRecord; artifacts: JournalArtifact[] }> {
  if (run.schemaVersion === JOURNAL_SCHEMA_VERSION) return { run, artifacts: [] }
  const split = await splitValidation(run.validation)
  const { validation: _validation, inputs: _inputs, ...rest } = run
  const upgraded: GenerationRecord = { ...rest, schemaVersion: JOURNAL_SCHEMA_VERSION }
  if (split.validation !== undefined) upgraded.validation = split.validation
  if (split.inputs) upgraded.inputs = split.inputs
  return { run: upgraded, artifacts: split.artifacts }
}

/** Version 1 request events copy the run's request; the copy goes, and one that differs stays because replay reads it. */
export function upgradeEvents(run: Pick<GenerationRecord, 'request'>, events: readonly JournalEvent[]): JournalEvent[] {
  const request = canonicalJson(run.request)
  return events.map((event) => {
    if (event.kind !== 'request' || event.data === undefined || canonicalJson(event.data) !== request) return event
    const { data: _data, ...rest } = event
    return rest
  })
}

export function summarize(run: GenerationRecord): GenerationSummary {
  const { request: _request, output: _output, validation: _validation, inputs: _inputs, ...summary } = run
  return summary
}

export function isJournalId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function json(value: unknown, depth = 0): value is JsonValue {
  if (depth > 80) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((entry) => json(entry, depth + 1))
  return object(value) && Object.entries(value).every(([key, entry]) => !['__proto__', 'constructor', 'prototype'].includes(key) && json(entry, depth + 1))
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function assertGenerationRecord(value: unknown): asserts value is GenerationRecord {
  if (!object(value) || (value.schemaVersion !== 1 && value.schemaVersion !== JOURNAL_SCHEMA_VERSION) || !isJournalId(value.id) ||
    !['plan', 'beats', 'script', 'sheet', 'panel', 'check', 'prompt'].includes(String(value.stage)) ||
    !['running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(String(value.status)) ||
    typeof value.model !== 'string' || typeof value.endpoint !== 'string' || typeof value.ownerId !== 'string' ||
    !timestamp(value.createdAt) || !timestamp(value.updatedAt) || !Number.isInteger(value.attempts) || Number(value.attempts) < 0 ||
    (value.finishedAt !== undefined && !timestamp(value.finishedAt)) ||
    (value.appliedAt !== undefined && !timestamp(value.appliedAt)) ||
    (value.applicationRequested !== undefined && typeof value.applicationRequested !== 'boolean') ||
    (value.error !== undefined && typeof value.error !== 'string') ||
    (value.parentId !== undefined && !isJournalId(value.parentId)) ||
    (value.operationId !== undefined && typeof value.operationId !== 'string') ||
    (value.outputArtifactId !== undefined && !isJournalId(value.outputArtifactId)) ||
    (value.validation !== undefined && !json(value.validation)) || (value.output !== undefined && !json(value.output)) ||
    (value.inputs !== undefined && (value.schemaVersion === 1 || !Array.isArray(value.inputs) || !value.inputs.every(isJournalId) ||
      new Set(value.inputs).size !== value.inputs.length))) {
    throw new Error('The generation record has an unsupported or invalid format.')
  }
  if (value.target !== undefined) {
    const target = value.target
    if (!object(target) || typeof target.adaptationId !== 'string' || typeof target.title !== 'string' ||
      ['chapter', 'page', 'panel'].some((key) => target[key] !== undefined && (!Number.isInteger(target[key]) || Number(target[key]) < 1)) ||
      (target.entityId !== undefined && typeof target.entityId !== 'string') ||
      (target.fingerprint !== undefined && typeof target.fingerprint !== 'string') ||
      (target.entityKind !== undefined && !['character', 'prop', 'place'].includes(String(target.entityKind)))) throw new Error('Invalid generation target.')
  }
  if (value.request !== undefined) {
    const request = value.request
    if (!object(request) || !['/chat/completions', '/images/generations', '/images/edits'].includes(String(request.path))) throw new Error('Invalid journal request path.')
    if (request.kind === 'json') {
      if (!object(request.body) || !json(request.body)) throw new Error('Invalid journal request body.')
    } else if (request.kind === 'form') {
      if (!Array.isArray(request.entries) || !request.entries.every((entry) => object(entry) && typeof entry.name === 'string' &&
        (typeof entry.value === 'string' || (isJournalId(entry.artifactId) && typeof entry.filename === 'string')))) throw new Error('Invalid journal form body.')
    } else throw new Error('Invalid journal request kind.')
  }
}

export async function validateBundle(bundle: JournalBundle): Promise<void> {
  assertGenerationRecord(bundle.run)
  if (!Array.isArray(bundle.events) || !Array.isArray(bundle.artifacts)) throw new Error('The journal bundle is incomplete.')
  const artifactIds = new Set<string>()
  const inputIds = new Set(bundle.run.inputs ?? [])
  const eventIds = new Set<string>()
  const sequences = new Set<number>()
  for (const artifact of bundle.artifacts) {
    if (!isJournalId(artifact.id) || (artifact.generationId !== bundle.run.id && !(inputIds.has(artifact.id) && isInputArtifact(artifact))) || artifactIds.has(artifact.id) ||
      typeof artifact.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(artifact.name) ||
      artifact.name.split('/').some((part) => !part || part === '..' || part === '.') ||
      typeof artifact.mime !== 'string' || !(artifact.blob instanceof Blob) || artifact.size !== artifact.blob.size ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) || await hashBlob(artifact.blob) !== artifact.sha256) {
      throw new Error('A journal file is missing, unsafe, or has changed.')
    }
    artifactIds.add(artifact.id)
  }
  for (const event of bundle.events) {
    if (!isJournalId(event.id) || event.generationId !== bundle.run.id || eventIds.has(event.id) ||
      !Number.isSafeInteger(event.sequence) || event.sequence < 0 || sequences.has(event.sequence) || !timestamp(event.at) ||
      !['started', 'request', 'response', 'transport-error', 'validation', 'completed', 'interrupted', 'applied'].includes(event.kind) ||
      (event.artifactId !== undefined && !artifactIds.has(event.artifactId)) ||
      (event.attempt !== undefined && (!Number.isSafeInteger(event.attempt) || event.attempt < 1)) ||
      (event.status !== undefined && (!Number.isInteger(event.status) || event.status < 0 || event.status > 599)) ||
      (event.message !== undefined && typeof event.message !== 'string') ||
      (event.data !== undefined && !json(event.data))) throw new Error('Invalid generation event history.')
    eventIds.add(event.id)
    sequences.add(event.sequence)
  }
  if (bundle.run.outputArtifactId && !artifactIds.has(bundle.run.outputArtifactId)) throw new Error('The generated output file is missing.')
  for (const id of inputIds) if (!artifactIds.has(id)) throw new Error('A saved validation input is missing.')
  if (bundle.run.request?.kind === 'form') {
    for (const entry of bundle.run.request.entries) if ('artifactId' in entry && !artifactIds.has(entry.artifactId)) throw new Error('A reference file is missing.')
  }
  const validateReferences = (value: JsonValue): void => {
    if (typeof value === 'string' && value.startsWith('journal-artifact:') && !artifactIds.has(value.slice(17))) throw new Error('A reference file is missing.')
    if (Array.isArray(value)) value.forEach(validateReferences)
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(validateReferences)
  }
  if (bundle.run.request?.kind === 'json') validateReferences(bundle.run.request.body)
}

/** Accepts version 1 and 2 bundles and always stores version 2. */
export async function importBundle(store: JournalStore, source: JournalBundle): Promise<void> {
  await validateBundle(source)
  const upgraded = await upgradeRecord(source.run)
  const bundle: JournalBundle = {
    run: upgraded.run,
    events: upgradeEvents(upgraded.run, source.events),
    artifacts: [...source.artifacts, ...upgraded.artifacts.filter((artifact) => !source.artifacts.some((item) => item.id === artifact.id))],
  }
  const existing = await store.getRun(bundle.run.id)
  if (existing) {
    const identity = (run: GenerationRecord) => JSON.stringify([run.createdAt, run.parentId, run.operationId, run.stage, run.model, run.target, run.validation, run.inputs])
    if (identity((await upgradeRecord(existing)).run) !== identity(bundle.run) || (existing.request && JSON.stringify(existing.request) !== JSON.stringify(bundle.run.request))) {
      throw new Error('A different generation already uses this ID.')
    }
    const oldEvents = upgradeEvents(existing, await store.getEvents(existing.id))
    const incoming = new Map(bundle.events.map((event) => [event.id, event]))
    for (const event of oldEvents) {
      const next = incoming.get(event.id)
      if (!next || JSON.stringify(next) !== JSON.stringify(event)) throw new Error('The imported journal would overwrite existing history.')
    }
    if (bundle.run.updatedAt < existing.updatedAt || (existing.appliedAt && bundle.run.appliedAt !== existing.appliedAt)) throw new Error('The imported generation is older than your local record.')
  }
  for (const artifact of bundle.artifacts) await store.putArtifact(artifact)
  for (const event of bundle.events) await store.putEvent(event)
  await store.putRun(bundle.run)
}

export async function readBundle(store: JournalStore, id: string): Promise<JournalBundle> {
  const run = await store.getRun(id)
  if (!run) throw new Error('Generation not found.')
  const events = await store.getEvents(id)
  const artifacts = await store.getArtifacts(id)
  for (const input of run.inputs ?? []) {
    const artifact = await store.getArtifact(input)
    if (artifact) artifacts.push(artifact)
  }
  return {run,events,artifacts}
}

export async function adaptationRunIds(store: Pick<JournalStore,'listRuns'>, adaptationId: string): Promise<string[]> {
  return (await store.listRuns()).filter((run) => run.target?.adaptationId === adaptationId).map((run) => run.id)
}
