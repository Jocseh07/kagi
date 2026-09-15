/** Query keys for database-backed reads, so writers can invalidate them. */
export const dbKeys = {
  library: ['db', 'library'] as const,
  manga: (sourceId: string, url: string) => ['db', 'manga', sourceId, url] as const,
  sourcePrefs: (sourceId: string) => ['db', 'source-prefs', sourceId] as const,
  storage: ['db', 'storage'] as const,
  /** Nested under `storage`, so invalidating that key refreshes this too. */
  storageBreakdown: ['db', 'storage', 'breakdown'] as const,
  savedChapters: ['db', 'saved-chapters'] as const,
  savedChapterIds: (mangaId: string) =>
    ['db', 'saved-chapter-ids', mangaId] as const,
  chapterPages: (chapterId: string) =>
    ['db', 'chapter-pages', chapterId] as const,
  /** Keyed by route params: the reader knows a chapter before its row id. */
  chapterSaved: (sourceId: string, slug: string, chapterKey: string) =>
    ['db', 'chapter-saved', sourceId, slug, chapterKey] as const,
  history: ['db', 'history'] as const,
  /** Group of the chapter last opened in one series. Sits under `history`. */
  lastReadGroup: (mangaId: string) => ['db', 'history', 'last-group', mangaId] as const,
  /** Stored chapter rows of one series, holding its read state. */
  chapters: (mangaId: string) => ['db', 'chapters', mangaId] as const,
  /** Prefix of every `chapters` key, for writers that only know a chapter id. */
  allChapters: ['db', 'chapters'] as const,
  /** Resume point of the chapter being read, keyed like `chapterSaved`. */
  chapterProgress: (sourceId: string, slug: string, chapterKey: string) =>
    ['db', 'chapter-progress', sourceId, slug, chapterKey] as const,

  /** Download queue rows and their aggregate counts. */
  queue: ['db', 'queue'] as const,
  queueSummary: ['db', 'queue-summary'] as const,

  /** The updates feed. `updatesUnseen` sits under it, so one invalidate covers both. */
  updates: ['db', 'updates'] as const,
  updatesUnseen: ['db', 'updates', 'unseen'] as const,

  /** Categories and the manga-to-category assignments. */
  categories: ['db', 'categories'] as const,
  mangaCategories: (mangaId: string) =>
    ['db', 'manga-categories', mangaId] as const,
}
