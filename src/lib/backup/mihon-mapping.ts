/**
 * The bridge between Mihon's identifiers and ours.
 *
 * A source appears here only when its Mihon url shape is known rather than
 * guessed at: a series imported under a shape this app cannot address is a row
 * that can never open a chapter, which is worse than one that was skipped and
 * said so.
 *
 * Two grades of evidence back the entries below, and the difference is noted on
 * each. Asura Scans and Thunder Scans were checked against a real export (58
 * series, 6486 chapters, no exceptions). The rest were read off the extensions'
 * own `setUrlWithoutDomain` calls, which is where the stored url comes from —
 * weaker than an export, stronger than a guess, and every one of them is a
 * shape this app's own source produces unchanged.
 *
 * Every entry emits this app's own url shapes — `/series/<slug>` and
 * `/series/<slug>/chapter/<key>` — because those are what the app addresses a
 * source by, not what the site or Mihon happens to store. See the note on
 * `seriesPath` in any of the new sources for why the two differ.
 *
 * Deliberately absent:
 *
 *  - **Comick.** The extension its backups were written by is dead, and the
 *    replacement addresses series differently. There is nothing to translate
 *    an old entry into.
 *  - **Toonily.** Its template now stores a bare numeric post id as the url,
 *    with the readable path kept in a memo this app's backup reader does not
 *    carry. An id cannot be turned into a slug without asking the site.
 */

import type { MangaStatus } from '@/lib/sources/types'
import type { MihonBackup, MihonManga } from './mihon'

/** The source ids this app can import into, keyed by our own source id. */
export type SupportedSourceId =
  | 'asurascans'
  | 'thunderscans'
  | 'weebcentral'
  | 'flamecomics'
  | 'mangadex'
  | 'mangakatana'
  | 'webtoons'
  | 'mangaplus'

interface SourceAdapter {
  /** How the source names itself in Mihon, for matching `backupSources`. */
  mihonName: string
  /**
   * What to call it in the UI. Duplicated from the registry's `Source.name`
   * rather than read from it, because importing the registry drags in every
   * source module — including the local-file ones, which only load in a
   * browser — and the plan this feeds has to run under Node too.
   */
  label: string
  /**
   * The id observed in a real backup, used only when the backup declares no
   * source entry for it — an extension uninstalled before the export leaves the
   * series behind but takes its name with it. The id is a hash of name, lang
   * and the extension's `versionId`, so it is stable until an extension bumps
   * that; the name match above is what normally decides.
   *
   * Absent for a source no real export has been read for. Such a source still
   * imports whenever the backup names it, which is the ordinary case.
   */
  fallbackId?: bigint
  /** `undefined` when the url is not a shape this source can act on. */
  mangaUrl(url: string): string | undefined
  chapterUrl(mangaUrl: string, chapterUrl: string): string | undefined
}

/** The rotating prefix Thunder Scans puts on a slug. Matches the source's own. */
const SLUG_PREFIX = /^\d+-/

const ADAPTERS: Record<SupportedSourceId, SourceAdapter> = {
  /**
   * Asura is a pass-through. Mihon stores `/series/<slug>` with the random
   * suffix already stripped (`AsuraScans.kt`) and chapters as
   * `/series/<slug>/chapter/<number>`, which is exactly what `toSChapter`
   * builds — so imported rows land on the same `(manga_id, url)` keys a live
   * chapter list produces, and a later refresh merges instead of duplicating.
   */
  asurascans: {
    mihonName: 'Asura Scans',
    label: 'Asura Scans',
    fallbackId: 6247824327199706550n,
    mangaUrl(url) {
      const slug = lastSegment(url)
      return slug && /^\/series\/[^/]+\/?$/.test(url) ? `/series/${slug}` : undefined
    },
    chapterUrl(mangaUrl, chapterUrl) {
      const number = lastSegment(chapterUrl)
      if (!number || !chapterUrl.includes('/chapter/')) return undefined
      return `${mangaUrl}/chapter/${number}`
    },
  },

  /**
   * Thunder needs both halves rewritten. Mihon keeps the MangaThemesia site
   * layout — `/comics/<slug>/` for a series and a *site-root* `/<chapter-slug>/`
   * for a chapter, which is not nested under the series at all — while this app
   * addresses both through `/series/<slug>` and carries the site's own chapter
   * slug as the last segment, exactly as `readChapters` reads it off an `href`.
   */
  thunderscans: {
    mihonName: 'Thunder Scans',
    label: 'Thunder Scans',
    fallbackId: 2848420679472350044n,
    mangaUrl(url) {
      if (!/^\/comics\/[^/]+\/?$/.test(url)) return undefined
      const slug = lastSegment(url)?.replace(SLUG_PREFIX, '')
      return slug ? `/series/${slug}` : undefined
    },
    chapterUrl(mangaUrl, chapterUrl) {
      const slug = lastSegment(chapterUrl)
      return slug ? `${mangaUrl}/chapter/${slug}` : undefined
    },
  },

  /**
   * Weeb Central is a pass-through. The extension stores whatever href the
   * listing carried — `/series/<id>/<slug>` for a series, `/chapters/<id>` for
   * a chapter — and this app's source builds both from the same hrefs, so the
   * keys line up and a later refresh merges rather than duplicating.
   *
   * A chapter is addressed independently of its series here, which is why the
   * translation ignores `mangaUrl` entirely.
   */
  weebcentral: {
    mihonName: 'Weeb Central',
    label: 'Weeb Central',
    mangaUrl(url) {
      const id = /^\/series\/([A-Za-z0-9]+)(?:\/[^/?#]+)?\/?$/.exec(url)?.[1]
      return id ? `/series/${id}` : undefined
    },
    chapterUrl(mangaUrl, chapterUrl) {
      const id = /^\/chapters\/([A-Za-z0-9]+)\/?$/.exec(chapterUrl)?.[1]
      return id ? `${mangaUrl}/chapter/${id}` : undefined
    },
  },

  /**
   * Flame Comics is a pass-through. Both halves are numeric-and-token paths the
   * extension writes verbatim: `/series/<id>` and `/series/<id>/<token>`.
   */
  flamecomics: {
    mihonName: 'Flame Comics',
    label: 'Flame Comics',
    mangaUrl(url) {
      const id = /^\/series\/(\d+)\/?$/.exec(url)?.[1]
      return id ? `/series/${id}` : undefined
    },
    chapterUrl(mangaUrl, chapterUrl) {
      const token = /^\/series\/\d+\/([A-Za-z0-9]+)\/?$/.exec(chapterUrl)?.[1]
      return token ? `${mangaUrl}/chapter/${token}` : undefined
    },
  },

  /**
   * MangaDex is a pass-through of two uuids.
   *
   * The extension ships one source per language and they share a name, so a
   * backup made in any language matches here. Only English is fetched, so a
   * series imported from another language's source will find no chapters on
   * refresh — it is still worth importing, because the library row, the cover
   * and the read history all survive.
   */
  mangadex: {
    mihonName: 'MangaDex',
    label: 'MangaDex',
    mangaUrl(url) {
      const id = /^\/manga\/([0-9a-f-]{36})\/?$/i.exec(url)?.[1]
      return id ? `/series/${id}` : undefined
    },
    chapterUrl(mangaUrl, chapterUrl) {
      const id = /^\/chapter\/([0-9a-f-]{36})\/?$/i.exec(chapterUrl)?.[1]
      return id ? `${mangaUrl}/chapter/${id}` : undefined
    },
  },

  /**
   * MangaKatana is a pass-through. The slug carries the site's numeric id after
   * a dot (`/manga/slayers-light-magic.5833`) and a chapter hangs off it.
   */
  mangakatana: {
    mihonName: 'MangaKatana',
    label: 'MangaKatana',
    mangaUrl(url) {
      const slug = /^\/manga\/([^/?#]+)\/?$/.exec(url)?.[1]
      return slug ? `/series/${slug}` : undefined
    },
    chapterUrl(mangaUrl, chapterUrl) {
      const part = /^\/manga\/[^/?#]+\/([^/?#]+)\/?$/.exec(chapterUrl)?.[1]
      return part ? `${mangaUrl}/chapter/${part}` : undefined
    },
  },

  /**
   * Webtoons stores the site's full address, where the identity is in the
   * query rather than the path: the genre and name are decoration the site
   * re-derives, while `title_no` and `episode_no` are what address the work.
   * Only the two numbers are carried over, which is also all this app's own
   * source keeps.
   */
  webtoons: {
    mihonName: 'Webtoons.com',
    label: 'Webtoons',
    mangaUrl(url) {
      const [path, query] = splitQuery(url)
      if (!/^\/[a-z-]+\/[^/?#]+\/[^/?#]+\/list$/.test(path)) return undefined
      const titleNo = new URLSearchParams(query).get('title_no')
      return titleNo ? `/series/${titleNo}` : undefined
    },
    chapterUrl(mangaUrl, chapterUrl) {
      const [path, query] = splitQuery(chapterUrl)
      if (!/^\/[a-z-]+\/[^/?#]+\/[^/?#]+\/[^/?#]+\/viewer$/.test(path)) {
        return undefined
      }
      const episodeNo = new URLSearchParams(query).get('episode_no')
      return episodeNo ? `${mangaUrl}/chapter/${episodeNo}` : undefined
    },
  },

  /**
   * MANGA Plus stores both halves as fragment paths (`#/titles/<id>`), which is
   * how its own single-page site addresses them. Only the ids survive.
   *
   * Most chapters in an old backup will no longer be readable: the service
   * frees only the first and last few of each series and rotates the rest out.
   * They import as rows and report as expired when opened, which is the truth
   * about them rather than a failure of the import.
   */
  mangaplus: {
    mihonName: 'MANGA Plus by SHUEISHA',
    label: 'MANGA Plus',
    mangaUrl(url) {
      const id = /^#\/titles\/(\d+)$/.exec(url)?.[1]
      return id ? `/series/${id}` : undefined
    },
    chapterUrl(mangaUrl, chapterUrl) {
      const id = /^#\/viewer\/(\d+)$/.exec(chapterUrl)?.[1]
      return id ? `${mangaUrl}/chapter/${id}` : undefined
    },
  },
}

export const SUPPORTED_SOURCE_IDS = Object.keys(ADAPTERS) as SupportedSourceId[]

export function sourceLabel(sourceId: SupportedSourceId): string {
  return ADAPTERS[sourceId].label
}

/** Mihon's `SManga` status constants, in their declared order. */
const MIHON_STATUS: MangaStatus[] = [
  'unknown',
  'ongoing',
  'completed',
  'licensed',
  'publishing_finished',
  'cancelled',
  'on_hiatus',
]

export function toMangaStatus(status: number): MangaStatus {
  return MIHON_STATUS[status] ?? 'unknown'
}

/**
 * Which of our sources a backup's 64-bit source id stands for.
 *
 * Built per backup: the ids are hashes we have no formula for, so the mapping
 * comes from the backup's own `backupSources` list, by name.
 */
export function resolveSources(
  backup: MihonBackup,
): Map<bigint, SupportedSourceId> {
  const byName = new Map<string, SupportedSourceId>(
    SUPPORTED_SOURCE_IDS.map((id) => [ADAPTERS[id].mihonName.toLowerCase(), id]),
  )

  const resolved = new Map<bigint, SupportedSourceId>()
  for (const id of SUPPORTED_SOURCE_IDS) {
    const fallbackId = ADAPTERS[id].fallbackId
    if (fallbackId !== undefined) resolved.set(fallbackId, id)
  }
  for (const source of backup.sources) {
    const match = byName.get(source.name.trim().toLowerCase())
    if (match) resolved.set(source.id, match)
  }
  return resolved
}

/** The display name a backup gives a source id, for naming what was skipped. */
export function sourceNames(backup: MihonBackup): Map<bigint, string> {
  return new Map(backup.sources.map((source) => [source.id, source.name]))
}

export interface MappedChapter {
  url: string
  name: string
  chapterNumber: number
  dateUpload: number | null
  read: boolean
  bookmarked: boolean
  lastPageRead: number
}

export interface MappedManga {
  sourceId: SupportedSourceId
  url: string
  title: string
  author: string | null
  artist: string | null
  description: string | null
  genres: string[] | null
  status: MangaStatus
  thumbnailUrl: string | null
  favorite: boolean
  dateAdded: number | null
  categoryOrders: number[]
  chapters: MappedChapter[]
  /** Read stamps keyed by *our* chapter url, already translated. */
  history: Map<string, number>
  /** Chapters dropped because their url made no sense for this source. */
  skippedChapters: number
}

/**
 * One backup series in our shape, or `null` when its url is not one this
 * source recognises — a stale entry from before an extension changed its url
 * scheme, which would otherwise be imported as a series that cannot load.
 */
export function mapManga(
  manga: MihonManga,
  sourceId: SupportedSourceId,
): MappedManga | null {
  const adapter = ADAPTERS[sourceId]
  const url = adapter.mangaUrl(manga.url)
  if (!url || !manga.title) return null

  const chapters: MappedChapter[] = []
  const chapterUrls = new Map<string, string>()
  let skippedChapters = 0

  for (const chapter of manga.chapters) {
    const mapped = adapter.chapterUrl(url, chapter.url)
    if (!mapped) {
      skippedChapters += 1
      continue
    }
    chapterUrls.set(chapter.url, mapped)
    chapters.push({
      url: mapped,
      name: chapter.name || lastSegment(mapped) || 'Chapter',
      chapterNumber: Number.isFinite(chapter.chapterNumber)
        ? chapter.chapterNumber
        : -1,
      dateUpload: chapter.dateUpload > 0 ? chapter.dateUpload : null,
      read: chapter.read,
      bookmarked: chapter.bookmark,
      lastPageRead: Math.max(0, chapter.lastPageRead),
    })
  }

  const history = new Map<string, number>()
  for (const entry of manga.history) {
    // A history row names its chapter by the *backup's* url, so it is
    // translated through the same table the chapters were.
    const mapped = chapterUrls.get(entry.chapterUrl)
    if (!mapped || entry.lastRead <= 0) continue
    history.set(mapped, Math.max(history.get(mapped) ?? 0, entry.lastRead))
  }

  return {
    sourceId,
    url,
    title: manga.title,
    author: manga.author || null,
    artist: manga.artist || null,
    description: manga.description || null,
    genres: manga.genres.length > 0 ? manga.genres : null,
    status: toMangaStatus(manga.status),
    thumbnailUrl: manga.thumbnailUrl || null,
    favorite: manga.favorite,
    dateAdded: manga.dateAdded > 0 ? manga.dateAdded : null,
    categoryOrders: manga.categoryOrders,
    chapters,
    history,
    skippedChapters,
  }
}

/** A path and its query string, with the `?` dropped and neither part decoded. */
function splitQuery(url: string): [string, string] {
  const index = url.indexOf('?')
  if (index === -1) return [url.split('#')[0] ?? url, '']
  return [url.slice(0, index), url.slice(index + 1).split('#')[0] ?? '']
}

function lastSegment(url: string): string | undefined {
  return url.split('?')[0]?.split('#')[0]?.split('/').filter(Boolean).pop()
}
