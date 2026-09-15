/**
 * A protobuf wire-format reader, and nothing more.
 *
 * Mihon serialises its backup with kotlinx-serialization's protobuf encoder and
 * ships no `.proto` file, so there is no schema to generate from — the field
 * numbers live in Kotlin annotations. A full protobuf runtime would therefore
 * add a dependency and still leave us hand-writing the mapping, so this reads
 * the wire format directly: enough to walk fields, and no schema at all.
 *
 * Unknown fields are returned like any other. A newer Mihon that adds a field
 * decodes here without a change; the mapper simply ignores what it does not
 * name.
 *
 * Nothing in here is Mihon-specific, which is why the MANGA Plus source reads
 * its own protobuf responses through the same accessors rather than shipping a
 * second copy of the wire format.
 */

/** The four wire types Mihon's encoder emits. Groups (3, 4) are long dead. */
export type WireType = 0 | 1 | 2 | 5

export interface Field {
  wire: WireType
  /** Varints and fixed64 arrive as bigint; the rest as their raw bytes. */
  value: bigint | Uint8Array
}

/** Fields of one message, keyed by field number. Repeated fields keep order. */
export type Message = Map<number, Field[]>

class Cursor {
  readonly bytes: Uint8Array
  offset: number

  constructor(bytes: Uint8Array, offset = 0) {
    this.bytes = bytes
    this.offset = offset
  }

  get done(): boolean {
    return this.offset >= this.bytes.length
  }

  varint(): bigint {
    let result = 0n
    let shift = 0n
    for (;;) {
      if (this.done) throw new Error('Truncated varint')
      const byte = this.bytes[this.offset++]!
      result |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return result
      shift += 7n
      // 10 groups of 7 bits is the widest a 64-bit varint can be.
      if (shift > 63n) throw new Error('Varint too long')
    }
  }

  take(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.bytes.length) {
      throw new Error('Truncated field')
    }
    const slice = this.bytes.subarray(this.offset, this.offset + length)
    this.offset += length
    return slice
  }
}

/** Splits one message's bytes into its fields. Throws on malformed input. */
export function decodeMessage(bytes: Uint8Array): Message {
  const cursor = new Cursor(bytes)
  const message: Message = new Map()

  while (!cursor.done) {
    const key = Number(cursor.varint())
    const number = key >>> 3
    const wire = (key & 7) as WireType

    let value: bigint | Uint8Array
    switch (wire) {
      case 0:
        value = cursor.varint()
        break
      case 1:
        value = cursor.take(8)
        break
      case 2:
        value = cursor.take(Number(cursor.varint()))
        break
      case 5:
        value = cursor.take(4)
        break
      default:
        throw new Error(`Unsupported wire type ${wire satisfies never}`)
    }

    const existing = message.get(number)
    if (existing) existing.push({ wire, value })
    else message.set(number, [{ wire, value }])
  }

  return message
}

// -------------------------------------------------------------- accessors --
//
// Every accessor takes the *last* occurrence of a non-repeated field, which is
// what protobuf specifies for a duplicate, and returns a default when the field
// is absent — proto3 does not write a field that holds its zero value, so
// "absent" and "zero" are the same thing on the wire.

function last(message: Message, number: number): Field | undefined {
  const fields = message.get(number)
  return fields?.[fields.length - 1]
}

const decoder = new TextDecoder()

export function readString(message: Message, number: number): string | undefined {
  const field = last(message, number)
  if (!field || field.wire !== 2) return undefined
  return decoder.decode(field.value as Uint8Array)
}

/** Every string of a repeated field, in wire order. */
export function readStrings(message: Message, number: number): string[] {
  const fields = message.get(number) ?? []
  return fields
    .filter((field) => field.wire === 2)
    .map((field) => decoder.decode(field.value as Uint8Array))
}

/**
 * A signed 64-bit value as a bigint.
 *
 * Source ids are hashes that routinely overflow `Number.MAX_SAFE_INTEGER`, so
 * they must not go through `Number` — two different sources could collapse onto
 * the same id. Kotlin's `Long` is signed and the encoder does not zigzag it, so
 * a negative id arrives as its two's-complement bit pattern.
 */
export function readLong(message: Message, number: number): bigint | undefined {
  const field = last(message, number)
  if (!field || field.wire !== 0) return undefined
  return BigInt.asIntN(64, field.value as bigint)
}

/** A varint small enough to be safe as a `number`: counts, timestamps, enums. */
export function readInt(message: Message, number: number): number | undefined {
  const value = readLong(message, number)
  return value === undefined ? undefined : Number(value)
}

export function readBool(message: Message, number: number): boolean | undefined {
  const value = readLong(message, number)
  return value === undefined ? undefined : value !== 0n
}

export function readFloat(message: Message, number: number): number | undefined {
  const field = last(message, number)
  if (!field || field.wire !== 5) return undefined
  const bytes = field.value as Uint8Array
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getFloat32(0, true)
}

/** One embedded message, or undefined when the field is absent. */
export function readMessage(
  message: Message,
  number: number,
): Message | undefined {
  const field = last(message, number)
  if (!field || field.wire !== 2) return undefined
  return decodeMessage(field.value as Uint8Array)
}

/** Every occurrence of a repeated embedded message, in wire order. */
export function readMessages(message: Message, number: number): Message[] {
  const fields = message.get(number) ?? []
  return fields
    .filter((field) => field.wire === 2)
    .map((field) => decodeMessage(field.value as Uint8Array))
}

/**
 * A repeated scalar, whether it was packed into one length-delimited field or
 * written one varint at a time. Both encodings are legal for the same field and
 * kotlinx picks per value, so a reader that handles only one of them is a bug
 * waiting on someone else's data.
 */
export function readPackedInts(message: Message, number: number): number[] {
  const out: number[] = []
  for (const field of message.get(number) ?? []) {
    if (field.wire === 0) {
      out.push(Number(field.value as bigint))
      continue
    }
    if (field.wire !== 2) continue
    const cursor = new Cursor(field.value as Uint8Array)
    while (!cursor.done) out.push(Number(cursor.varint()))
  }
  return out
}
