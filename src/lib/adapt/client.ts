import type { AdaptSettings } from './settings'
import { bridgeFetch } from './desktop-bridge'
import { beginGeneration, jsonValue } from './journal/runtime'
import type { JournalCapture } from './journal/runtime'
import type { JournalOptions, JournalPath, JsonValue } from './journal/types'

const MAX_ATTEMPTS = 6
/** Outages rarely clear within a few retries; rate limits do. */
const OUTAGE_ATTEMPTS = 3
/** The safety filter judges the drawn image, so the same prompt usually passes on a redraw. */
const MODERATION_ATTEMPTS = 3
const BASE_DELAY_MS = 2000
const MAX_DELAY_MS = 60_000
/** A provider asking for a near-zero Retry-After would otherwise get every retry back to back. */
const MIN_RETRY_DELAY_MS = 500
/** Far past any real JSON reply; a longer one is a runaway generation, not a draft worth repairing. */
const MAX_CHAT_REPLY_CHARS = 2_000_000
/** How much of a broken reply goes back to the model for repair, split between its start and end. */
const REPAIR_EXCERPT_CHARS = 32_000
/** Well past the slowest healthy draw seen at 32 in flight (4m38s); past this the upstream socket is dead. */
const IMAGE_DEADLINE_MS = 360_000
/** Long scripts run past 4 minutes; a reply this late is not coming, and resending restarts it from nothing. */
const CHAT_DEADLINE_MS = 900_000
const CHAT_PATH = '/chat/completions'
const TEXT_STAGE_DEADLINE_MS = CHAT_DEADLINE_MS * 2

export interface ChatAttempt {
  attempt: number
  model: string
  reason?: string
}

export interface ChatOptions extends JournalOptions {
  onAttempt?: (event: ChatAttempt) => void
}

export function createTextStageSignal(signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(TEXT_STAGE_DEADLINE_MS)
  return signal ? AbortSignal.any([signal, deadline]) : deadline
}

type Connection = Pick<AdaptSettings, 'endpoint' | 'apiKey'>

export class AdaptApiError extends Error {
  readonly status: number
  readonly code: string | null
  /** The blocked sheet's name, so the error can say which one to edit. */
  readonly subject: string | null

  constructor(message: string, status: number, code: string | null = null, subject: string | null = null) {
    super(message)
    this.name = 'AdaptApiError'
    this.status = status
    this.code = code
    this.subject = subject
  }
}

/** Blocked with no reference sheets attached, so the panel's own wording is what the filter refuses. */
export const PROMPT_BLOCKED = 'panel_prompt_blocked'

/** A cast or prop sheet blocked even after its description was toned down. */
export const SHEET_BLOCKED = 'sheet_prompt_blocked'

/** Requests only go to an endpoint you entered; a missing setting never falls back to one. */
export const MISSING_ENDPOINT = 'No endpoint is set. Add one in Settings under Adapt.'

export function isModerationBlocked(cause: unknown): boolean {
  return cause instanceof AdaptApiError && cause.code === 'moderation_blocked'
}

function errorCode(body: string): string | null {
  try {
    const code = (JSON.parse(body) as { error?: { code?: unknown } }).error?.code
    return typeof code === 'string' ? code : null
  } catch {
    return null
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Jittered so a burst of requests refused together does not retry together. */
function backoff(attempt: number, retryAfter: string | null): number {
  const asked = Number(retryAfter)
  if (retryAfter && Number.isFinite(asked) && asked > 0) return Math.min(MAX_DELAY_MS, Math.max(MIN_RETRY_DELAY_MS, asked * 1000))
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1)) * (0.5 + Math.random())
}

function attemptsFor(status: number, code: string | null, attempts: number): number {
  if (status === 429) return attempts
  if (code === 'moderation_blocked') return Math.min(attempts, MODERATION_ATTEMPTS)
  if (status >= 500) return Math.min(attempts, OUTAGE_ATTEMPTS)
  return 1
}

/** Stops reading once the body passes `limit`, so a runaway reply is never held in full. */
async function boundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return response.text()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    text += decoder.decode(value, { stream: true })
    if (text.length > limit) {
      await reader.cancel()
      return text
    }
  }
}

async function api(
  connection: Connection,
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
  attempts = MAX_ATTEMPTS,
  onAttempt?: (attempt: number, reason?: string) => void,
  capture?: JournalCapture,
): Promise<unknown> {
  if (!connection.endpoint.trim()) throw new AdaptApiError(MISSING_ENDPOINT, 0)
  const deadline = path.startsWith('/images/') ? IMAGE_DEADLINE_MS : path === CHAT_PATH ? CHAT_DEADLINE_MS : undefined
  let reason: string | undefined
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted()
    onAttempt?.(attempt, reason)
    await capture?.attempt(attempt, reason)
    let response: Response
    const timeout = deadline ? AbortSignal.timeout(deadline) : undefined
    try {
      const request: RequestInit = {
        ...init,
        signal: timeout && signal ? AbortSignal.any([signal, timeout]) : (timeout ?? signal),
        headers: {
          ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
          ...init.headers,
        },
      }
      const url = `${connection.endpoint}${path}`
      response = await (bridgeFetch(url, request) ?? fetch(url, request))
    } catch (cause) {
      await capture?.transportError(attempt, cause)
      if (signal?.aborted) throw cause
      if (timeout?.aborted && path === CHAT_PATH) throw chatTimeout()
      if (attempt >= Math.min(attempts, OUTAGE_ATTEMPTS)) {
        if (timeout?.aborted) {
          throw new AdaptApiError(`${path} gave no reply in ${deadline! / 60_000} minutes, ${attempt} times.`, 0)
        }
        throw new AdaptApiError(`Can't reach ${connection.endpoint}. Start CLIProxy, then retry.`, 0)
      }
      reason = 'Connection interrupted'
      await sleep(backoff(attempt, null), signal)
      continue
    }

    let body: string
    try {
      body = path === CHAT_PATH ? await boundedText(response, MAX_CHAT_REPLY_CHARS) : await response.text()
    } catch (cause) {
      if (timeout?.aborted && path === CHAT_PATH && !signal?.aborted) throw chatTimeout()
      throw cause
    }
    await capture?.response(attempt, response.status, body)
    if (path === CHAT_PATH && body.length > MAX_CHAT_REPLY_CHARS) {
      throw new MalformedReplyError(`The reply ran past ${MAX_CHAT_REPLY_CHARS / 1_000_000} million characters. Reply with the JSON text only, no images`)
    }
    if (response.ok) {
      try {
        return JSON.parse(body)
      } catch (cause) {
        if (path === CHAT_PATH && cause instanceof SyntaxError) {
          throw new MalformedReplyError('The provider returned unreadable JSON.', body)
        }
        throw cause
      }
    }
    const code = errorCode(body)
    if (attempt >= attemptsFor(response.status, code, attempts)) {
      throw new AdaptApiError(`${path} failed (${response.status}): ${body.slice(0, 300)}`, response.status, code)
    }
    reason = response.status === 429 ? 'Waiting for the rate limit' : `Provider error ${response.status}`
    await sleep(backoff(attempt, response.headers.get('Retry-After')), signal)
  }
}

// Not status 0: a slow reply stops its own chapter, not every chapter the endpoint is serving.
function chatTimeout(): AdaptApiError {
  return new AdaptApiError(
    `The model gave no reply in ${CHAT_DEADLINE_MS / 60_000} minutes. Retry, or switch the model in Settings.`,
    408,
  )
}

// One quick attempt: this backs "Test connection", where a stalled retry looks like nothing happened.
export async function listModels(connection: Connection): Promise<string[]> {
  const data = (await api(connection, '/models', { method: 'GET' }, AbortSignal.timeout(10_000), 1)) as {
    data?: { id: string }[]
  }
  return (data.data ?? []).map((model) => model.id).sort()
}

export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

export async function chatJson<T>(
  connection: Connection & Pick<AdaptSettings, 'priority'>,
  model: string,
  system: string,
  user: string | readonly ContentPart[],
  signal?: AbortSignal,
  options?: ChatOptions,
): Promise<T> {
  const result = await executeGenerationRequest(connection, model, CHAT_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
      ...(connection.priority ? { service_tier: 'priority' } : {}),
    }),
  }, signal, options)
  return result.output as T
}

function chatOutput(data: unknown, model: string): JsonValue {
  const envelope = data as { choices?: { message?: { content?: unknown }; finish_reason?: string }[] } | null

  const choice = Array.isArray(envelope?.choices) ? envelope.choices[0] : undefined
  const content = choice?.message?.content
  if (typeof content !== 'string') throw new MalformedReplyError(`${model} returned no text.`)
  if (choice?.finish_reason === 'length') throw new MalformedReplyError(`${model} reached its output limit.`, content)
  const json = firstObject(content)
  if (!json) throw new MalformedReplyError(`${model} returned no JSON.`, content)
  try {
    return jsonValue(JSON.parse(json))
  } catch (cause) {
    throw new MalformedReplyError(`${model} returned broken JSON: ${(cause as Error).message}`, content)
  }
}

export function malformedFeedback(error: MalformedReplyError): string {
  return `Your previous reply was not one valid JSON object (${error.message}). Escape every double quote inside a string value as \\". Reply with only the corrected JSON object, nothing before or after it.`
}

/** The start and end of a broken reply, so a huge one does not grow every repair prompt. */
export function replyExcerpt(content: string | undefined): string {
  if (!content || content.length <= REPAIR_EXCERPT_CHARS) return content ?? ''
  const half = REPAIR_EXCERPT_CHARS / 2
  return `${content.slice(0, half)}\n[${content.length - REPAIR_EXCERPT_CHARS} characters left out]\n${content.slice(-half)}`
}

export class MalformedReplyError extends Error {
  readonly content?: string

  constructor(message: string, content?: string) {
    super(message)
    this.name = 'MalformedReplyError'
    this.content = content
  }
}

// Models sometimes add a note or a second object after the JSON, so stop at the first balanced close.
function firstObject(content: string): string | null {
  const start = content.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < content.length; index++) {
    const char = content[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) return content.slice(start, index + 1)
  }
  return null
}

function envelopeValue(data: unknown): JsonValue {
  try {
    return jsonValue(data)
  } catch {
    throw new AdaptApiError('The image model returned an unreadable reply. Retry this panel.', 200)
  }
}

async function imageBlob(data: unknown, signal?: AbortSignal, capture?: JournalCapture): Promise<Blob> {
  const item = (data as { data?: { b64_json?: unknown; url?: unknown }[] } | null)?.data?.[0]
  if (typeof item?.b64_json === 'string' && item.b64_json) {
    try {
      const bytes = Uint8Array.from(atob(item.b64_json), (char) => char.charCodeAt(0))
      return new Blob([bytes], { type: 'image/png' })
    } catch {
      throw new AdaptApiError('The image model returned invalid image data. Retry this panel.', 200)
    }
  }
  if (typeof item?.url === 'string' && item.url) {
    const deadline = AbortSignal.timeout(IMAGE_DEADLINE_MS)
    const response = await fetch(item.url, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline })
    if (!response.ok) {
      await capture?.response(capture.run.attempts, response.status, await response.text())
      throw new AdaptApiError('The generated image could not be downloaded. Retry this panel.', response.status)
    }
    const image = await response.blob()
    if (!image.size || !image.type.startsWith('image/')) {
      await capture?.response(capture.run.attempts, response.status, await image.text())
      throw new AdaptApiError('The provider returned a file instead of an image. Retry this panel.', 200)
    }
    return image
  }
  throw new AdaptApiError('The image model returned no image.', 200)
}

export async function generateImage(
  connection: Connection,
  model: string,
  prompt: string,
  size: string,
  signal?: AbortSignal,
  options?: JournalOptions,
): Promise<Blob> {
  const result = await executeGenerationRequest(connection, model, '/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, size, n: 1, quality: 'low' }),
  }, signal, options)
  if (!result.image) throw new AdaptApiError('The image model returned no image.', 200)
  return result.image
}

export async function editImage(
  connection: Connection,
  model: string,
  prompt: string,
  refs: readonly Blob[],
  size: string,
  signal?: AbortSignal,
  options?: JournalOptions,
): Promise<Blob> {
  const form = new FormData()
  form.set('model', model)
  form.set('prompt', prompt)
  form.set('size', size)
  form.set('quality', 'low')
  refs.forEach((ref, index) => form.append('image[]', ref, `ref-${index + 1}.png`))
  const result = await executeGenerationRequest(connection, model, '/images/edits', { method: 'POST', body: form }, signal, options)
  if (!result.image) throw new AdaptApiError('The image model returned no image.', 200)
  return result.image
}

export async function executeGenerationRequest(
  connection: Connection,
  model: string,
  path: JournalPath,
  init: RequestInit,
  signal?: AbortSignal,
  options?: ChatOptions,
): Promise<{ output: JsonValue; image?: Blob }> {
  const capture = await beginGeneration(model, connection, path === CHAT_PATH ? 'script' : 'panel', options)
  try {
    await capture?.prepare(path, init.body)
    const data = await api(connection, path, init, signal, options?.maxAttempts,
      (attempt, reason) => options?.onAttempt?.({ attempt, model, reason }), capture)
    const output = path === CHAT_PATH ? chatOutput(data, model) : envelopeValue(data)
    const image = path === CHAT_PATH ? undefined : await imageBlob(data, signal, capture)
    await capture?.finish(output, image)
    return { output, image }
  } catch (cause) {
    await capture?.fail(cause, signal)
    throw cause
  }
}
