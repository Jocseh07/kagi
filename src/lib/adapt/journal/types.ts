export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export type GenerationStage = 'plan' | 'beats' | 'script' | 'sheet' | 'panel' | 'check' | 'prompt'
export type GenerationStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'

export interface GenerationTarget {
  adaptationId: string
  title: string
  chapter?: number
  page?: number
  panel?: number
  entityId?: string
  entityKind?: 'character' | 'prop' | 'place'
  fingerprint?: string
}

export interface GenerationContext {
  stage: GenerationStage
  target?: GenerationTarget
  operationId?: string
  parentId?: string
  /** Validation fields small enough to keep in the record; the rest live in `inputs`. */
  validation?: JsonValue
  /** Content-addressed artifacts, each a JSON object of validation fields shared across runs. */
  inputs?: string[]
}

export type JournalPath = '/chat/completions' | '/images/generations' | '/images/edits'
export type JournalFormEntry = { name: string; value: string } | { name: string; artifactId: string; filename: string }
export type JournalRequest =
  | { path: JournalPath; kind: 'json'; body: JsonObject }
  | { path: JournalPath; kind: 'form'; entries: JournalFormEntry[] }

export interface GenerationRecord extends GenerationContext {
  /** 1 records keep every validation field inline; only version 2 is written. */
  schemaVersion: 1 | 2
  id: string
  model: string
  endpoint: string
  status: GenerationStatus
  createdAt: number
  updatedAt: number
  finishedAt?: number
  attempts: number
  request?: JournalRequest
  output?: JsonValue
  outputArtifactId?: string
  error?: string
  appliedAt?: number
  applicationRequested?: boolean
  ownerId: string
}

/** What run lists keep in memory: everything except request, output and validation payloads. */
export type GenerationSummary = Omit<GenerationRecord, 'request' | 'output' | 'validation' | 'inputs'>

export interface JournalEvent {
  id: string
  generationId: string
  sequence: number
  at: number
  kind: 'started' | 'request' | 'response' | 'transport-error' | 'validation' | 'completed' | 'interrupted' | 'applied'
  attempt?: number
  status?: number
  message?: string
  artifactId?: string
  data?: JsonValue
}

export interface JournalArtifact {
  id: string
  generationId: string
  name: string
  mime: string
  size: number
  sha256: string
  blob: Blob
}

export interface JournalBundle {
  run: GenerationRecord
  events: JournalEvent[]
  artifacts: JournalArtifact[]
}

export interface JournalStore {
  putRun(run: GenerationRecord): Promise<void>
  getRun(id: string): Promise<GenerationRecord | undefined>
  listRuns(): Promise<GenerationRecord[]>
  putEvent(event: JournalEvent): Promise<void>
  getEvents(generationId: string): Promise<JournalEvent[]>
  putArtifact(artifact: JournalArtifact): Promise<void>
  getArtifact(id: string): Promise<JournalArtifact | undefined>
  getArtifacts(generationId: string): Promise<JournalArtifact[]>
  deleteRun(id: string): Promise<void>
}

export interface JournalOptions {
  context?: GenerationContext
  store?: JournalStore
  onRecord?: (id: string) => void
  maxAttempts?: number
  replayId?: string
}

export interface ReplayOptions {
  endpoint: string
  apiKey: string
  attempt?: number
  model?: string
  prompt?: string
  maxRequests?: number
  signal?: AbortSignal
}

export interface ReplacementImpact {
  title: string
  details: string[]
}
