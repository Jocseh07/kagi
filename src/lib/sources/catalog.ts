/**
 * The static facts about each source: what it is called and whether it serves
 * comics or prose.
 *
 * This exists to keep the app shell light. Answering "is `novelfull` a novel
 * source?" through the registry means constructing all seven sources, and two
 * of them reach a ZIP decoder for local CBZ and EPUB files — a quarter of a
 * megabyte that the shell downloaded before it could draw anything. The answer
 * is a literal on each class, so it can be a literal here instead.
 *
 * Nothing in this module may import a source implementation. That is the whole
 * point of it; an import here puts the scrapers back on the critical path.
 *
 * The duplication is real and is checked: `registry.ts` asserts on load that
 * every registered source agrees with its entry below.
 */

import type { ContentKind } from './types'

export interface SourceCatalogEntry {
  id: string
  name: string
  /** Comics when omitted on the class, matching `kindOf`. */
  contentKind: ContentKind
}

export const sourceCatalog: readonly SourceCatalogEntry[] = [
  { id: 'asurascans', name: 'Asura Scans', contentKind: 'comic' },
  { id: 'mangadot', name: 'Mangadot', contentKind: 'comic' },
  { id: 'thunderscans', name: 'Thunder Scans', contentKind: 'comic' },
  { id: 'weebcentral', name: 'Weeb Central', contentKind: 'comic' },
  { id: 'flamecomics', name: 'Flame Comics', contentKind: 'comic' },
  { id: 'mangakatana', name: 'MangaKatana', contentKind: 'comic' },
  { id: 'mangakakalot', name: 'Mangakakalot', contentKind: 'comic' },
  { id: 'mangadex', name: 'MangaDex', contentKind: 'comic' },
  { id: 'comick', name: 'Comick', contentKind: 'comic' },
  { id: 'toonily', name: 'Toonily', contentKind: 'comic' },
  { id: 'webtoons', name: 'Webtoons', contentKind: 'comic' },
  { id: 'mangaplus', name: 'MANGA Plus', contentKind: 'comic' },
  { id: 'novelfull', name: 'NovelFull', contentKind: 'novel' },
  { id: 'fenrirealm', name: 'Fenrir Realm', contentKind: 'novel' },
  { id: 'webnovel', name: 'Webnovel', contentKind: 'novel' },
  { id: 'novelmtl', name: 'NovelMTL', contentKind: 'novel' },
  { id: 'wuxiaworld', name: 'WuxiaWorld', contentKind: 'novel' },
  { id: 'local', name: 'Local files', contentKind: 'comic' },
  { id: 'local-novel', name: 'Local novels', contentKind: 'novel' },
]

const byId = new Map(sourceCatalog.map((entry) => [entry.id, entry]))

/**
 * An id the catalog does not know is treated as a comic — the same default
 * `kindOf` applies to a source that omits the field, and the same default the
 * `manga.contentKind` column carries.
 */
export function contentKindOfId(sourceId: string): ContentKind {
  return byId.get(sourceId)?.contentKind ?? 'comic'
}

/** The id of the source with this display name, matched case-insensitively. */
export function findSourceIdByName(name: string): string | undefined {
  const wanted = name.toLowerCase()
  return sourceCatalog.find((entry) => entry.name.toLowerCase() === wanted)?.id
}
