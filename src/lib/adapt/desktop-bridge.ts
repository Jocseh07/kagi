import type { GenerationRecord, JournalArtifact, JournalEvent } from './journal/types'

export type ArtifactTransfer = Omit<JournalArtifact, 'blob'> & { bytes: ArrayBuffer }

export interface JournalTransfer {
  run: GenerationRecord
  events: JournalEvent[]
  artifacts: ArtifactTransfer[]
}

export interface DesktopJournalBridge {
  location(): Promise<string>
  list(): Promise<GenerationRecord[]>
  read(id: string): Promise<JournalTransfer>
  write(bundle: JournalTransfer): Promise<void>
  putRun(run: GenerationRecord): Promise<void>
  putEvent(event: JournalEvent): Promise<void>
  putArtifact(artifact: ArtifactTransfer): Promise<void>
  delete(id: string): Promise<void>
}

export interface DesktopNavState {
  canGoBack: boolean
  canGoForward: boolean
}

export interface DesktopNavBridge {
  back(): void
  forward(): void
  state(): Promise<DesktopNavState>
  onChange(listener: (state: DesktopNavState) => void): () => void
}

export type BridgeFormEntry = { name: string; value: string } | { name: string; filename: string; type: string; bytes: ArrayBuffer }

export type BridgeBody = { kind: 'text'; text: string } | { kind: 'form'; entries: BridgeFormEntry[] }

export interface BridgeRequest {
  id: string
  url: string
  method: string
  headers: [string, string][]
  body: BridgeBody | null
}

export interface BridgeResponse {
  status: number
  headers: [string, string][]
  body: string
}

/** Exposed by the desktop app's preload; absent in a browser. */
export interface DesktopBridge {
  request(request: BridgeRequest): Promise<BridgeResponse>
  abort(id: string): void
  journal: DesktopJournalBridge
  nav: DesktopNavBridge
}

declare global {
  interface Window {
    kagiDesktop?: DesktopBridge
  }
}

/** The only hosts the desktop app's main process will call for the page. */
export const LOOPBACK_HOSTS: Readonly<Record<string, true>> = { localhost: true, '127.0.0.1': true, '[::1]': true }

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

/**
 * Sends a local-endpoint request through the desktop app's main process, which
 * has no per-host connection cap. Null in a browser or for a remote endpoint.
 */
export function bridgeFetch(url: string, init: RequestInit): Promise<Response> | null {
  const bridge = typeof window === 'undefined' ? undefined : window.kagiDesktop
  if (!bridge || LOOPBACK_HOSTS[new URL(url).hostname] !== true) return null
  return viaBridge(bridge, url, init)
}

async function viaBridge(bridge: DesktopBridge, url: string, init: RequestInit): Promise<Response> {
  const signal = init.signal ?? undefined
  const request: BridgeRequest = {
    id: crypto.randomUUID(),
    url,
    method: init.method ?? 'GET',
    headers: [...new Headers(init.headers).entries()],
    body: await bridgeBody(init.body),
  }
  signal?.throwIfAborted()
  const onAbort = () => bridge.abort(request.id)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const reply = await bridge.request(request)
    return new Response(NULL_BODY_STATUSES.has(reply.status) ? null : reply.body, {
      status: reply.status,
      headers: reply.headers,
    })
  } catch (cause) {
    if (signal?.aborted) throw signal.reason
    throw new TypeError(cause instanceof Error ? cause.message : String(cause))
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

async function bridgeBody(body: RequestInit['body']): Promise<BridgeBody | null> {
  if (body == null) return null
  if (typeof body === 'string') return { kind: 'text', text: body }
  if (body instanceof FormData) {
    const entries: BridgeFormEntry[] = []
    const fields: Iterable<[string, FormDataEntryValue]> = body.entries()
    for (const [name, value] of fields) {
      entries.push(
        typeof value === 'string'
          ? { name, value }
          : { name, filename: value.name, type: value.type, bytes: await value.arrayBuffer() },
      )
    }
    return { kind: 'form', entries }
  }
  throw new TypeError('The desktop bridge sends only text and form bodies.')
}
