export interface HttpRequest {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  /** Bytes for a binary protocol; the gRPC-web source posts framed protobuf. */
  body?: string | Uint8Array<ArrayBuffer>
  /** Aborts the request in flight. Omitted requests behave exactly as before. */
  signal?: AbortSignal
}

export interface HttpResponse {
  status: number
  url: string
  headers: Headers
  text(): Promise<string>
  json<T>(): Promise<T>
  blob(): Promise<Blob>
}

/**
 * The single seam through which every source reaches the network.
 *
 * A browser can only satisfy this for origins that send CORS headers. Sources
 * that need more must surface `CorsBlockedError` so the UI can explain why
 * rather than showing a dead spinner.
 */
export interface HttpTransport {
  fetch(req: HttpRequest): Promise<HttpResponse>
}

export class CorsBlockedError extends Error {
  readonly requestUrl: string
  /** The page origin the request was refused for. */
  readonly pageOrigin: string

  constructor(requestUrl: string, cause?: unknown) {
    const origin = currentOrigin()
    super(
      `${safeHost(requestUrl)} refused a cross-origin read from ${origin}. ` +
        `The request left the browser but the response could not be read.` +
        (isPickyOrigin(origin)
          ? ` Some sources allow http://localhost but reject IP addresses and ` +
            `other plain-http origins — try opening the app on ` +
            `http://localhost instead of ${origin}.`
          : ''),
    )
    this.name = 'CorsBlockedError'
    this.requestUrl = requestUrl
    this.pageOrigin = origin
    this.cause = cause
  }
}

/**
 * Plain-http origins that are not `localhost` — loopback by IP, LAN addresses,
 * `.local` names. Sources commonly allowlist `localhost` for development and
 * nothing else over http, so the same machine fails or succeeds purely by the
 * name it was reached under. Worth saying out loud: it looks like a broken
 * build otherwise.
 */
function isPickyOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' && url.hostname !== 'localhost'
  } catch {
    return false
  }
}

function currentOrigin(): string {
  return typeof location === 'undefined' ? 'this page' : location.origin
}

/**
 * Marks a proxied response as a bot check rather than an ordinary failure, and
 * carries the upstream URL a reader has to open to clear it.
 *
 * Set in scripts/curl-proxy.ts, which declares the same literal rather than
 * importing this one — it is compiled under the Node tsconfig and this module
 * is browser code. Change one and change the other.
 */
export const CHALLENGE_HEADER = 'x-proxy-challenge'

/**
 * The site answered with a bot check instead of the page.
 *
 * Distinct from `HttpStatusError` because the remedy is a human one: the check
 * has to be cleared in a real tab, which no retry from here can do. Raised only
 * for responses the proxy marked as such — see `CHALLENGE_HEADER` in
 * scripts/curl-proxy.ts.
 */
export class ChallengeRequiredError extends Error {
  /** The upstream page to open in a tab, not the proxy path we requested. */
  readonly siteUrl: string
  readonly requestUrl: string

  constructor(siteUrl: string, requestUrl: string) {
    super(
      `${safeHost(siteUrl)} asked for a human check instead of returning the ` +
        `page. It has to be cleared in a browser tab before this will load.`,
    )
    this.name = 'ChallengeRequiredError'
    this.siteUrl = siteUrl
    this.requestUrl = requestUrl
  }
}

export class HttpStatusError extends Error {
  readonly status: number
  readonly requestUrl: string

  constructor(status: number, requestUrl: string) {
    super(`HTTP ${status} for ${requestUrl}`)
    this.name = 'HttpStatusError'
    this.status = status
    this.requestUrl = requestUrl
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
