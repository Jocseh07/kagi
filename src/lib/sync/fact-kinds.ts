/**
 * What a fact is, and how it is addressed.
 *
 * A fact is one decision the reader made, named by the thing it is about
 * rather than by a row id. Two devices that have never spoken produce the same
 * key for the same series, so there is no identity to reconcile and no
 * duplicate to collapse — the failure mode the row-mirroring design had.
 *
 * Deliberately free of imports. Both halves of the app compile this: the
 * browser client and the Worker routes, the latter under `nodenext` resolution
 * where a relative import needs its extension.
 */

/**
 * The kinds, in the order a pull must apply them.
 *
 * Everything below `cat` needs a series to hang on, and `member` needs its
 * category too, so the two that create those come first. `hist` comes before
 * `read` and `pos` for the same reason one level down: it is the only fact
 * carrying a chapter's name and number, so it is the only one that can create
 * a chapter this device has never fetched — and the other two then have
 * something to mark.
 */
export const FACT_KINDS = [
  /** A series the reader has met. `state` says whether it is in the library. */
  'lib',
  /** A category, addressed by its folded name. */
  'cat',
  /** A chapter in the reading history. */
  'hist',
  /** A chapter marked read. */
  'read',
  /** How far into a chapter the reader got. */
  'pos',
  /** A series' membership of a category. */
  'member',
  /** One synced preference. */
  'set',
] as const

export type FactKind = (typeof FACT_KINDS)[number]

/** `state` is a small enum, not a flag, so a kind can grow a third answer. */
export const HIDDEN = 0
export const PRESENT = 1

/**
 * Key separator.
 *
 * ASCII unit separator: it cannot appear in a url, a source id, or a category
 * name, so a key can be split back into its parts without escaping.
 */
export const SEP = '\u001f'

export function seriesKey(sourceId: string, mangaUrl: string): string {
  return `${sourceId}${SEP}${mangaUrl}`
}

export function chapterKey(
  sourceId: string,
  mangaUrl: string,
  chapterUrl: string,
): string {
  return `${sourceId}${SEP}${mangaUrl}${SEP}${chapterUrl}`
}

/** The series a chapter key belongs to. */
export function seriesKeyOf(chapterKeyValue: string): string {
  const at = chapterKeyValue.lastIndexOf(SEP)
  return at === -1 ? chapterKeyValue : chapterKeyValue.slice(0, at)
}

/**
 * A category is its name.
 *
 * Folded so that "Reading" created on a phone and "reading" created on a
 * laptop are one category rather than two. The display spelling travels in the
 * payload; this is only the address.
 */
export function categoryKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function memberKey(category: string, series: string): string {
  return `${category}${SEP}${series}`
}

export function partsOf(key: string): string[] {
  return key.split(SEP)
}

/**
 * Marks a setting as this device's own bookkeeping.
 *
 * Sync stores its cursor in `settings` like anything else, but that value
 * describes *this* device's position and is meaningless — actively harmful —
 * on another one: a peer that adopted it would resume from a stranger's place
 * and skip its own pending changes. Checked when a fact is written and again
 * when one is applied, because an install that synced under the old protocol
 * still has cursor rows sitting on the server.
 *
 * The library filter is a view choice for one screen, so it stays on the
 * device that set it rather than narrowing every other device's library.
 */
export function isDeviceLocalSetting(key: string): boolean {
  return key.startsWith('sync.') || key === 'library.filters'
}

export function isFactKind(value: string): value is FactKind {
  return (FACT_KINDS as readonly string[]).includes(value)
}

// --------------------------------------------------------------- payloads --

/**
 * The smallest label that lets a device draw something it has not fetched yet.
 *
 * A device pulling a library it has never browsed has no titles and no covers
 * until it reaches every source, which is slow and rate limited. These two
 * fields are the difference between a library of blank cards and a usable one.
 * Everything else the source owns — description, genres, author, status — is
 * refetched and never travels.
 */
export interface SeriesLabel {
  /** Title. */
  t?: string
  /** Cover url. */
  c?: string
}

/** The same idea for a history entry, which shows a chapter it may not hold. */
export interface ChapterLabel {
  /** Chapter name. */
  n?: string
  /** Chapter number. */
  i?: number
}

export function encodeLabel(label: SeriesLabel | ChapterLabel): string | null {
  const entries = Object.entries(label).filter(
    ([, value]) => value !== undefined && value !== null && value !== '',
  )
  if (entries.length === 0) return null
  return JSON.stringify(Object.fromEntries(entries))
}

function decodeLabel(payload: string | null | undefined): Record<string, unknown> {
  if (!payload) return {}
  try {
    const parsed: unknown = JSON.parse(payload)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function seriesLabel(payload: string | null | undefined): SeriesLabel {
  const raw = decodeLabel(payload)
  return {
    t: typeof raw.t === 'string' ? raw.t : undefined,
    c: typeof raw.c === 'string' ? raw.c : undefined,
  }
}

export function chapterLabel(payload: string | null | undefined): ChapterLabel {
  const raw = decodeLabel(payload)
  return {
    n: typeof raw.n === 'string' ? raw.n : undefined,
    i: typeof raw.i === 'number' && Number.isFinite(raw.i) ? raw.i : undefined,
  }
}

// ------------------------------------------------------------ the one rule --

/** The comparable part of a fact. */
export interface FactVersion {
  gen: number
  val: number
}

/**
 * Whether `incoming` replaces `stored`, from a *client's* point of view.
 *
 * A later generation always wins. Within one generation the further value
 * wins, which is what keeps reading progress monotonic without consulting a
 * clock. Equal generation and equal value resolves to the incoming fact
 * because the only place this is asked with an equal pair is a pull, and the
 * server holds exactly one fact per key: whatever it kept is what every device
 * must agree on. The server rejects its own ties in the other direction, so
 * the first write to land is the one that survives everywhere.
 */
export function supersedes(incoming: FactVersion, stored: FactVersion): boolean {
  if (incoming.gen !== stored.gen) return incoming.gen > stored.gen
  return incoming.val >= stored.val
}
