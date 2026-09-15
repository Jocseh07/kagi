/**
 * WuxiaWorld's protobuf responses, mapped to plain objects.
 *
 * The API publishes no `.proto` file. The field numbers below come from the
 * site's own generated client — `/assets/novels.*.min.js`,
 * `chapters.*.min.js` and `pagination.*.min.js`, which carry every message's
 * name, number and type — and each one was checked against a live response
 * before being written down.
 *
 * Only the messages this source reads are mapped, and only the fields it uses.
 * An unknown field decodes and is ignored, so a server-side addition costs
 * nothing here.
 */

import {
  readBool,
  readInt,
  readMessage,
  readMessages,
  readString,
  readStrings,
} from '../../backup/protobuf'
import type { Message } from '../../backup/protobuf'

/**
 * `NovelItem.Status`. Named rather than mapped here because the same enum is
 * both a response value and a search parameter.
 */
export const NOVEL_STATUS = {
  finished: 0,
  active: 1,
  hiatus: 2,
  all: -1,
} as const

export interface NovelDto {
  id: number
  name: string
  slug: string
  /** One of `NOVEL_STATUS`. Absent on the wire means `finished`, which is 0. */
  status: number
  language?: string
  /** The blurb. `description` is the translator's credits and links instead. */
  synopsis?: string
  description?: string
  coverUrl?: string
  authorName?: string
  translatorName?: string
  genres: string[]
  /**
   * The pricing entity, which the unlock terms are keyed on. Equal to `id` on
   * every novel checked, but read rather than assumed.
   */
  seriesId?: number
}

export interface ChapterDto {
  entityId: number
  name: string
  slug: string
  /** The site's own chapter number. 0 on a prologue and on bulk imports. */
  number?: number
  visible: boolean
  /** True when the title would spoil the chapter, so the site hides it too. */
  spoilerTitle: boolean
  /** Milliseconds. */
  publishedAt?: number
  /**
   * True when the body is a truncated preview rather than the chapter.
   *
   * The other half of the lock signal, and the half that does not look like
   * one: a locked chapter either omits `content` entirely or returns the
   * opening paragraphs with `isTeaser` set, which would otherwise read as a
   * very short chapter that stops mid-sentence.
   */
  isTeaser: boolean
  isFree: boolean
  karmaPrice?: number
  /**
   * Absent on a locked chapter. The API answers `grpc-status: 0` with the whole
   * record and simply omits the body, so this is the only lock signal at read
   * time.
   */
  content?: string
  translatorThoughts?: string
}

export interface SearchPageDto {
  novels: NovelDto[]
  /** Novels matching the query, not novels in this page. */
  total: number
}

/**
 * What it takes to read past the free window, from the novel's active pricing
 * models.
 *
 * Several models are active at once — a free window, a wait timer, a karma
 * price — so this flattens them into the three numbers worth telling a reader.
 */
export interface UnlockTermsDto {
  freeChapters?: number
  waitSeconds?: number
  unlocksPerWait?: number
}

// ------------------------------------------------------------------ novels --

export function parseSearchNovels(response: Message): SearchPageDto {
  return {
    novels: readMessages(response, 1).map(toNovel),
    total: readInt(response, 2) ?? 0,
  }
}

export function parseNovel(response: Message): NovelDto {
  const item = readMessage(response, 1)
  if (!item) throw new Error('WuxiaWorld served no novel.')
  return toNovel(item)
}

function toNovel(item: Message): NovelDto {
  const series = readMessage(item, 25)

  return {
    id: readInt(item, 1) ?? 0,
    name: readString(item, 2) ?? '',
    slug: readString(item, 3) ?? '',
    status: readInt(item, 4) ?? NOVEL_STATUS.finished,
    language: unwrapString(item, 6),
    description: unwrapString(item, 8),
    synopsis: unwrapString(item, 9),
    coverUrl: unwrapString(item, 10),
    translatorName: unwrapString(item, 11),
    authorName: unwrapString(item, 13),
    genres: readStrings(item, 16),
    seriesId: series && readInt(series, 1),
  }
}

// ---------------------------------------------------------------- chapters --

export interface ChapterListDto {
  chapters: ChapterDto[]
  /**
   * Who translated the novel, from the `novelInfo` the same response carries.
   * Read here so that a chapter fetch alone still knows it, without a second
   * call for the novel.
   */
  translator?: string
}

/**
 * Every chapter of a novel, flattened out of its volume groups.
 *
 * Groups arrive with an `order` and their chapters in reading order within each
 * group, so the groups are sorted and then concatenated. Sorting the chapters
 * themselves would be wrong: a group's numbering restarts on some novels.
 */
export function parseChapterList(response: Message): ChapterListDto {
  const novelInfo = readMessage(response, 2)

  return {
    chapters: readMessages(response, 1)
      .map((group) => ({
        order: readInt(group, 3) ?? 0,
        chapters: readMessages(group, 6).map(toChapter),
      }))
      .sort((left, right) => left.order - right.order)
      .flatMap((group) => group.chapters),
    translator: novelInfo && unwrapString(novelInfo, 11),
  }
}

export function parseChapter(response: Message): ChapterDto {
  const item = readMessage(response, 1)
  if (!item) throw new Error('WuxiaWorld served no chapter.')
  return toChapter(item)
}

function toChapter(item: Message): ChapterDto {
  const pricing = readMessage(item, 20)
  const karma = readMessage(item, 13)
  const published = readMessage(item, 18)

  return {
    entityId: readInt(item, 1) ?? 0,
    name: readString(item, 2) ?? '',
    slug: readString(item, 3) ?? '',
    number: unwrapInt(item, 4),
    // Proto3 omits a false bool, and every listed chapter carries `visible:
    // true`, so absent means the field was dropped as its zero value.
    visible: readBool(item, 7) ?? false,
    spoilerTitle: readBool(item, 10) ?? false,
    publishedAt: published && toMillis(published),
    isTeaser: readBool(item, 8) ?? false,
    isFree: (pricing && readBool(pricing, 1)) ?? false,
    karmaPrice: karma && unwrapInt(karma, 1),
    content: unwrapString(item, 5),
    translatorThoughts: unwrapString(item, 19),
  }
}

function toMillis(timestamp: Message): number | undefined {
  const seconds = readInt(timestamp, 1)
  return seconds === undefined ? undefined : seconds * 1000
}

// ------------------------------------------------------------------ genres --

/**
 * The genre taxonomy. Two levels: eleven primary genres and twenty-two
 * secondary ones. Both are accepted by the search filter, which takes names
 * rather than ids, so only the names are kept.
 */
export function parseGenres(response: Message): string[] {
  return readMessages(response, 1)
    .map((genre) => readString(genre, 2))
    .filter((name): name is string => Boolean(name))
}

// ----------------------------------------------------------------- pricing --

export function parseUnlockTerms(response: Message): UnlockTermsDto {
  const terms: UnlockTermsDto = {}

  for (const model of readMessages(response, 1)) {
    if (readBool(model, 3) !== true) continue

    // The free window is stated by whichever model is charging past it, so the
    // widest one wins rather than the last one read.
    for (const gate of [
      readMessage(model, 4),
      readMessage(model, 5),
      readMessage(model, 7),
    ]) {
      const free = gate && unwrapInt(gate, 1)
      if (free !== undefined && free > (terms.freeChapters ?? 0)) {
        terms.freeChapters = free
      }
    }

    const wait = readMessage(model, 6)
    if (!wait) continue

    const free = unwrapInt(wait, 2)
    if (free !== undefined && free > (terms.freeChapters ?? 0)) {
      terms.freeChapters = free
    }
    const duration = readMessage(wait, 1)
    terms.waitSeconds = duration && readInt(duration, 1)
    terms.unlocksPerWait = readInt(wait, 4)
  }

  return terms
}

// ----------------------------------------------------------------- wrappers --

/** `google.protobuf.StringValue`, which is a message holding one string. */
function unwrapString(message: Message, number: number): string | undefined {
  const wrapper = readMessage(message, number)
  if (!wrapper) return undefined
  return readString(wrapper, 1) ?? ''
}

/** `google.protobuf.Int32Value`. A wrapper holding zero decodes as empty. */
function unwrapInt(message: Message, number: number): number | undefined {
  const wrapper = readMessage(message, number)
  if (!wrapper) return undefined
  return readInt(wrapper, 1) ?? 0
}
