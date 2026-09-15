/**
 * gRPC-web, for the one source that speaks it.
 *
 * WuxiaWorld's API is gRPC with the standard browser bridge in front of it: a
 * unary call is a POST whose body is a length-prefixed protobuf message, and
 * whose response is a sequence of those frames ending in one that carries the
 * trailers. There is no JSON transcoding on the deployment, so this is the
 * protocol or nothing.
 *
 * Two halves live here, and neither knows anything about WuxiaWorld:
 *
 *  - **A protobuf writer.** `src/lib/backup/protobuf.ts` reads the wire format
 *    and nothing here duplicates it; requests need the other direction, which
 *    that module has never had a reason to grow.
 *  - **The frame codec.** Deliberately not a gRPC runtime. Unary calls over a
 *    known set of methods need five bytes of framing and a trailer parse, and
 *    a real runtime would add a dependency to do the same thing behind a
 *    channel abstraction this app has no use for.
 *
 * `application/grpc-web+proto` rather than the base64 `-text` variant: the
 * binary form is what the site's own client sends, and the transport already
 * hands back bytes through `blob()`.
 */

import { decodeMessage } from '../../backup/protobuf'
import type { Message } from '../../backup/protobuf'
import type { HttpTransport } from '../../transport/types'

/**
 * A byte buffer over a real `ArrayBuffer`, which is what `fetch` accepts as a
 * body. Plain `Uint8Array` widens to `ArrayBufferLike` and would not.
 */
export type Bytes = Uint8Array<ArrayBuffer>

/** Frame flags. Bit 0 marks compression, bit 7 marks the trailer frame. */
const COMPRESSED_FLAG = 0x01
const TRAILER_FLAG = 0x80

/** A call the server answered with a non-zero `grpc-status`. */
export class GrpcError extends Error {
  readonly status: number

  constructor(status: number, detail: string) {
    super(detail || `gRPC call failed with status ${status}.`)
    this.name = 'GrpcError'
    this.status = status
  }
}

// ----------------------------------------------------------------- writing --

const encoder = new TextEncoder()

/**
 * A varint, via bigint so that a negative enum encodes as protobuf specifies:
 * sign-extended to 64 bits, ten bytes on the wire. `NovelItem.Status.All` is
 * `-1`, and a naive 32-bit encoder would send it as five bytes the server
 * rejects.
 */
function varint(value: number): number[] {
  let remaining = BigInt.asUintN(64, BigInt(value))
  const bytes: number[] = []
  for (;;) {
    const byte = Number(remaining & 0x7fn)
    remaining >>= 7n
    if (remaining === 0n) {
      bytes.push(byte)
      return bytes
    }
    bytes.push(byte | 0x80)
  }
}

/** A varint-typed field: int32, int64, bool and enum all share this encoding. */
export function writeInt(field: number, value: number): Bytes {
  return Uint8Array.from([...varint((field << 3) | 0), ...varint(value)])
}

export function writeBool(field: number, value: boolean): Bytes {
  return writeInt(field, value ? 1 : 0)
}

/** A length-delimited field: strings, bytes and embedded messages. */
export function writeMessage(field: number, body: Bytes): Bytes {
  const header = Uint8Array.from([...varint((field << 3) | 2), ...varint(body.length)])
  const out = new Uint8Array(header.length + body.length)
  out.set(header)
  out.set(body, header.length)
  return out
}

export function writeString(field: number, value: string): Bytes {
  return writeMessage(field, encoder.encode(value))
}

/**
 * `google.protobuf.Int32Value` and `StringValue`.
 *
 * The wrappers exist so that a field can be *absent* rather than zero, and the
 * distinction is load-bearing on this API: `searchAfterId` unset means "from the
 * start", while `searchAfterId` holding 0 is a cursor position.
 */
export function writeIntValue(field: number, value: number): Bytes {
  return writeMessage(field, writeInt(1, value))
}

export function writeStringValue(field: number, value: string): Bytes {
  return writeMessage(field, writeString(1, value))
}

/** One message's fields, concatenated in the order given. */
export function message(...parts: Bytes[]): Bytes {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

// ----------------------------------------------------------------- calling --

/**
 * One unary call: `POST /<service>/<method>` with a single framed message in
 * and a single framed message out.
 */
export async function unary(
  http: HttpTransport,
  apiBase: string,
  method: string,
  request: Bytes,
  signal?: AbortSignal,
): Promise<Message> {
  const res = await http.fetch({
    url: `${apiBase}/${method}`,
    method: 'POST',
    headers: {
      'content-type': 'application/grpc-web+proto',
      'x-grpc-web': '1',
    },
    body: frame(request),
    signal,
  })

  // A trailers-only response puts the status in the headers instead of in a
  // frame, which is how a rejected call with no body arrives.
  assertOk(res.headers.get('grpc-status'), res.headers.get('grpc-message'))

  const bytes = new Uint8Array(await (await res.blob()).arrayBuffer())
  const payload = readFrames(bytes)
  if (!payload) throw new Error(`${method} returned no message.`)
  return decodeMessage(payload)
}

function frame(body: Bytes): Bytes {
  const out = new Uint8Array(5 + body.length)
  new DataView(out.buffer).setUint32(1, body.length)
  out.set(body, 5)
  return out
}

/**
 * The first message frame, having checked every trailer frame along the way.
 *
 * Trailers are read before the payload is returned rather than after, because a
 * server is free to send a partial message and then fail: reporting the status
 * beats handing a truncated message to the mappers.
 */
function readFrames(bytes: Bytes): Bytes | null {
  let payload: Bytes | null = null
  let offset = 0

  while (offset + 5 <= bytes.length) {
    const flag = bytes[offset]!
    const length = new DataView(
      bytes.buffer,
      bytes.byteOffset + offset + 1,
      4,
    ).getUint32(0)
    const body = bytes.subarray(offset + 5, offset + 5 + length)
    offset += 5 + length

    if ((flag & TRAILER_FLAG) !== 0) {
      readTrailers(body)
      continue
    }
    if ((flag & COMPRESSED_FLAG) !== 0) {
      // Only sent when the client advertises an encoding, which this does not.
      throw new Error('WuxiaWorld compressed a gRPC frame; this reader cannot.')
    }
    payload ??= body
  }

  return payload
}

const decoder = new TextDecoder()

/** The trailer frame is HTTP header syntax: `name: value` per line. */
function readTrailers(body: Uint8Array): void {
  let status: string | null = null
  let detail: string | null = null

  for (const line of decoder.decode(body).split('\r\n')) {
    const separator = line.indexOf(':')
    if (separator < 0) continue
    const name = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    if (name === 'grpc-status') status = value
    if (name === 'grpc-message') detail = value
  }

  assertOk(status, detail)
}

function assertOk(status: string | null, detail: string | null): void {
  if (status === null || status === '0') return
  throw new GrpcError(Number(status), decodeDetail(detail))
}

/** `grpc-message` is percent-encoded, and not always validly. */
function decodeDetail(detail: string | null): string {
  if (!detail) return ''
  try {
    return decodeURIComponent(detail)
  } catch {
    return detail
  }
}
