/**
 * MANGA Plus's protobuf responses, mapped to plain objects.
 *
 * The API publishes no `.proto` file, so the field numbers below come from the
 * Kotlin extension's annotations and were each checked against a live response
 * before being written down. The wire reader itself is
 * `src/lib/backup/protobuf.ts` — generic despite where it lives, and the reason
 * this file is a schema rather than a parser.
 *
 * Only the messages this source reads are mapped. An unknown field decodes and
 * is ignored, so a server-side addition costs nothing here.
 */

import {
  decodeMessage,
  readInt,
  readMessage,
  readMessages,
  readString,
} from '@/lib/backup/protobuf'
import type { Message } from '@/lib/backup/protobuf'

export interface Title {
  titleId: number
  name: string
  author?: string
  portraitImageUrl?: string
}

export interface Chapter {
  chapterId: number
  /** The site's own label, e.g. `#1192`. */
  name: string
  /**
   * The episode's real title. Absent means the chapter has rotated out of its
   * free window and cannot be opened, which is the only signal the API gives.
   */
  subTitle?: string
  /** Unix seconds. */
  startTimeStamp?: number
}

export interface TitleDetail {
  title: Title
  overview?: string
  viewingPeriodDescription?: string
  nonAppearanceInfo?: string
  genres: string[]
  chapters: Chapter[]
}

export interface ViewerPage {
  imageUrl: string
  /** Hex. The image bytes are this key XORed over them, repeating. */
  encryptionKey?: string
}

export interface Viewer {
  /** Sent back as `Plus-Vw-Token`; an image fetched without it answers 400. */
  viewToken?: string
  pages: ViewerPage[]
}

/** What the API says went wrong, in the reader's language where it has one. */
export class MangaPlusError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MangaPlusError'
  }
}

/**
 * The `success` half of a response, or a thrown error carrying the popup the
 * API answered with instead.
 *
 * Every endpoint returns the same envelope, so this is the one place that
 * decides whether a response is usable.
 */
function successOf(bytes: Uint8Array): Message {
  const response = decodeMessage(bytes)

  const success = readMessage(response, 1)
  if (success) return success

  const error = readMessage(response, 2)
  // English popup first, Spanish second; the API sends whichever it has.
  const popup = error && (readMessage(error, 2) ?? readMessage(error, 3))
  const body = popup && readString(popup, 2)

  throw new MangaPlusError(body?.trim() || 'MANGA Plus refused the request.')
}

function toTitle(message: Message): Title {
  return {
    titleId: readInt(message, 1) ?? 0,
    name: readString(message, 2) ?? '',
    author: readString(message, 3),
    portraitImageUrl: readString(message, 4),
  }
}

function toChapter(message: Message): Chapter {
  return {
    chapterId: readInt(message, 2) ?? 0,
    name: readString(message, 3) ?? '',
    subTitle: readString(message, 4),
    startTimeStamp: readInt(message, 6),
  }
}

/** `title_list/rankingV2`: the ranked titles, flattened out of their groups. */
export function parseRanking(bytes: Uint8Array): Title[] {
  const view = readMessage(successOf(bytes), 37)
  if (!view) return []

  return readMessages(view, 3).flatMap((ranked) =>
    readMessages(ranked, 2).map(toTitle),
  )
}

/** `web/web_homeV4`: the titles that updated recently, newest group first. */
export function parseWebHome(bytes: Uint8Array): Title[] {
  const view = readMessage(successOf(bytes), 38)
  if (!view) return []

  const updated = [
    ...readMessages(view, 2).flatMap((group) => readMessages(group, 2)),
    ...(readMessage(view, 7) ? [readMessage(readMessage(view, 7)!, 2)!] : []),
  ].filter(Boolean)

  return updated
    .flatMap((entry) => readMessages(entry, 3))
    .map((latest) => readMessage(latest, 1))
    .filter((title): title is Message => title !== undefined)
    .map(toTitle)
}

/** `title_list/allV2`: the whole catalogue, which is what search reads. */
export function parseAllTitles(bytes: Uint8Array): Title[] {
  const view = readMessage(successOf(bytes), 25)
  if (!view) return []

  return readMessages(view, 1).flatMap((group) =>
    readMessages(group, 2).map(toTitle),
  )
}

/** `title_detailV3`: one title with its chapter list and genres. */
export function parseTitleDetail(bytes: Uint8Array): TitleDetail {
  const view = readMessage(successOf(bytes), 8)
  if (!view) throw new MangaPlusError('MANGA Plus served no details.')

  const title = readMessage(view, 1)
  if (!title) throw new MangaPlusError('MANGA Plus served no title.')

  // A group holds up to three runs of chapters — the opening ones, the middle,
  // and the latest. The Kotlin extension reads two of the three; all three are
  // read here because a live response was observed using each of them, and a
  // missed run is a hole in the middle of someone's chapter list.
  const chapters = readMessages(view, 28).flatMap((group) => [
    ...readMessages(group, 2).map(toChapter),
    ...readMessages(group, 3).map(toChapter),
    ...readMessages(group, 4).map(toChapter),
  ])

  return {
    title: toTitle(title),
    overview: readString(view, 3),
    viewingPeriodDescription: readString(view, 7),
    nonAppearanceInfo: readString(view, 8),
    genres: readMessages(view, 31)
      .map((tag) => readString(tag, 1))
      .filter((name): name is string => Boolean(name)),
    chapters,
  }
}

/** `manga_viewer_v3`: one chapter's pages and the token they are served under. */
export function parseViewer(bytes: Uint8Array): Viewer {
  const view = readMessage(successOf(bytes), 10)
  if (!view) throw new MangaPlusError('MANGA Plus served no viewer.')

  const pages: ViewerPage[] = []
  for (const wrapper of readMessages(view, 1)) {
    // A viewer's page list is padded with non-image entries — adverts, the
    // "last page" card — and those carry no inner page message at all.
    const page = readMessage(wrapper, 1)
    const imageUrl = page && readString(page, 1)
    if (!page || !imageUrl) continue

    pages.push({ imageUrl, encryptionKey: readString(page, 5) })
  }

  return { viewToken: readString(view, 19), pages }
}
