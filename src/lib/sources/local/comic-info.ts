/**
 * `ComicInfo.xml`, the metadata format Mihon now prefers for local series.
 *
 * Two places hold one: the series folder describes the series, and a chapter
 * archive (or chapter folder) describes that one chapter. Both use the same
 * schema, so one parse yields both shapes and the caller picks the half it
 * wants — see `metadata.ts` for which file wins.
 *
 * **This source only ever reads.** Mihon, on finding the deprecated
 * `details.json`, writes an equivalent `ComicInfo.xml` next to it and deletes
 * the JSON, and it drops a `.noxml` marker into folders whose archives held no
 * metadata. We deliberately do neither: a reader that rewrites and deletes
 * files in the user's library can destroy data it does not own, and the folder
 * is opened read-only anyway. Both formats are read, neither is written.
 *
 * Fields follow the v2.0 schema (anansi-project) plus the two namespaced
 * extensions Mihon writes: `ty:PublishingStatusTachiyomi` and `ty:Categories`.
 * Element names are matched by local name, so any namespace prefix works.
 */

import type { MangaStatus } from '../types'
import type { LocalDetails } from './scan'
import { statusOf, stringOf } from './scan'

export const COMIC_INFO_FILE = 'ComicInfo.xml'

/** Opt-out marker: a series folder holding this is never searched for XML. */
export const NO_XML_FILE = '.noxml'

export interface ComicInfoChapter {
  name?: string
  chapterNumber?: number
  scanlator?: string
}

export interface ComicInfoMetadata {
  /**
   * Series-level fields. `title` comes from `<Series>` only — `<Title>` is the
   * *chapter* title in a chapter archive, so it is offered as `chapter.name`
   * and only promoted to a series title by the top-level caller.
   */
  series: LocalDetails
  chapter: ComicInfoChapter
}

/**
 * Parse a ComicInfo document. Returns null for anything that is not one.
 *
 * Nothing here throws: a truncated, empty or wrong-schema file leaves the
 * series described by its folder name, which is always better than an error
 * screen over metadata the user may not know exists.
 */
export function parseComicInfo(text: string): ComicInfoMetadata | null {
  const fields = readFields(text)
  if (!fields) return null

  const metadata: ComicInfoMetadata = {
    series: {
      title: fields.get('series'),
      author: fields.get('writer'),
      artist: joinField(fields, ARTIST_FIELDS),
      description: fields.get('summary'),
      genre: listField(fields, GENRE_FIELDS),
      status: seriesStatus(fields),
    },
    chapter: {
      name: fields.get('title'),
      chapterNumber: numberOf(fields.get('number')),
      scanlator: fields.get('translator'),
    },
  }

  return metadata
}

// ---------------------------------------------------------------- mapping --

/**
 * Everyone who drew the book. Mihon collapses the whole credit block into one
 * artist line rather than dropping all but the penciller.
 */
const ARTIST_FIELDS = [
  'penciller',
  'inker',
  'colorist',
  'letterer',
  'coverartist',
] as const

/** `ty:Categories` is Mihon's own; the other two are schema fields. */
const GENRE_FIELDS = ['genre', 'tags', 'categories'] as const

/** Values are comma-separated lists in every one of these fields. */
function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function listField(
  fields: Map<string, string>,
  keys: readonly string[],
): string[] | undefined {
  const seen = new Set<string>()
  for (const key of keys) {
    const value = fields.get(key)
    if (value) for (const item of splitList(value)) seen.add(item)
  }
  return seen.size > 0 ? [...seen] : undefined
}

function joinField(
  fields: Map<string, string>,
  keys: readonly string[],
): string | undefined {
  return listField(fields, keys)?.join(', ')
}

function numberOf(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Publication status.
 *
 * `ty:PublishingStatusTachiyomi` holds it verbatim ("On hiatus", "Publishing
 * finished", …) when Mihon wrote the file. Files from other taggers have no
 * status field at all, so `<Count>` — the total number of issues in the series
 * — stands in: a known total is only knowable once the run is over. It is a
 * weak signal, so an explicit status always wins.
 */
function seriesStatus(fields: Map<string, string>): MangaStatus | undefined {
  const declared = statusOf(fields.get('publishingstatustachiyomi'))
  if (declared) return declared

  const count = numberOf(fields.get('count'))
  return count !== undefined && count > 0 ? 'publishing_finished' : undefined
}

// ---------------------------------------------------------------- parsing --

/**
 * Non-empty child elements of `<ComicInfo>`, keyed by lowercased local name.
 * First occurrence wins, matching how the schema treats repeated elements.
 */
function readFields(text: string): Map<string, string> | null {
  const root = readRoot(text)
  if (!root) return null

  const fields = new Map<string, string>()
  for (const child of Array.from(root.children)) {
    const value = stringOf(child.textContent)
    if (!value) continue
    // `ty:PublishingStatusTachiyomi` parsed as HTML keeps its prefix in the
    // element name, so the prefix is stripped rather than matched.
    const key = child.localName.toLowerCase().split(':').pop()
    if (key && !fields.has(key)) fields.set(key, value)
  }

  return fields
}

function readRoot(text: string): Element | null {
  if (typeof DOMParser === 'undefined' || !text.trim()) return null

  const parser = new DOMParser()

  // A malformed document does not throw: it parses into a `<parsererror>`
  // root, which this name check rejects along with any file that simply is not
  // a ComicInfo.
  const root = parse(parser, text, 'application/xml')?.documentElement
  if (root && root.localName.toLowerCase() === 'comicinfo') return root

  // Files written by hand or by a third-party tagger routinely carry an
  // undeclared `ty:` prefix or an unescaped `&`, either of which fails XML
  // parsing outright. The HTML parser recovers from both, and every field read
  // here is plain text, so nothing is lost by falling back to it.
  //
  // A file that never closes its root element is a different matter: it was
  // truncated mid-write or mid-copy, and the HTML parser would happily hand
  // back half a title. Those are left to the folder name.
  if (!CLOSING_TAG.test(text)) return null

  return parse(parser, text, 'text/html')?.querySelector('comicinfo') ?? null
}

const CLOSING_TAG = /<\/\s*comicinfo\s*>/i

function parse(
  parser: DOMParser,
  text: string,
  type: 'application/xml' | 'text/html',
): Document | null {
  try {
    return parser.parseFromString(text, type)
  } catch {
    return null
  }
}
