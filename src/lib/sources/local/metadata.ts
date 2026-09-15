/**
 * Where a local series' metadata comes from, and what reading it is allowed to
 * cost.
 *
 * Precedence follows Mihon: the series folder's own `ComicInfo.xml` first, the
 * deprecated JSON details file next, and failing both, the `ComicInfo.xml`
 * inside the first chapter that carries one. A `.noxml` file in the series
 * folder is Mihon's opt-out marker and skips every XML lookup here, series and
 * chapter alike, leaving the folder and file names to describe the library.
 *
 * Nothing is written back. Mihon converts the JSON to XML and deletes it, and
 * drops a `.noxml` of its own when a scan comes up empty; this source only
 * reads — see `comic-info.ts`.
 *
 * ## Cost
 *
 * Chapter metadata lives inside the archives, and opening every archive on
 * every refresh is what makes Mihon's own refresh slow on large libraries.
 * Five things keep it bounded:
 *
 *  1. it only runs on the series screen — a shelf listing never opens a file;
 *  2. only the archive's central directory is read and only the ComicInfo
 *     entry is inflated, so page images are never touched;
 *  3. results are memoised per chapter for the session, negatives included, so
 *     a React Query refetch or a return visit re-opens nothing;
 *  4. a series whose first few chapters hold no XML is marked barren and not
 *     probed again, which is the whole cost for a library that never had any;
 *  5. reads run a few at a time rather than all at once, so a 900-chapter
 *     series cannot open 900 files in parallel.
 */

import { parseComicInfo, COMIC_INFO_FILE, NO_XML_FILE } from './comic-info'
import type { ComicInfoChapter, ComicInfoMetadata } from './comic-info'
import { readArchiveEntryText } from './archive'
import { readDetails } from './scan'
import type { ChapterEntry, DirectoryListing, LocalDetails } from './scan'

/** Chapters opened before a series is written off as having no XML at all. */
const PROBE_LIMIT = 5

/** Concurrent archive reads. Enough to hide latency, few enough to be polite. */
const READ_CONCURRENCY = 4

/** Parsed chapters held per session. Well past any real series' chapter count. */
const CACHE_LIMIT = 4000

export interface LocalMetadata {
  details: LocalDetails
  /** Keyed by `ChapterEntry.entryName`; absent for chapters with no XML. */
  chapters: Map<string, ComicInfoChapter>
}

/** Insertion-ordered, so the first key is the oldest. Nulls are cached too. */
const parsed = new Map<string, ComicInfoMetadata | null>()
const barren = new Set<string>()

/** Called when the chosen folder changes: every cached parse is now stale. */
export function clearLocalMetadata(): void {
  parsed.clear()
  barren.clear()
}

export async function readLocalMetadata(
  seriesName: string,
  series: FileSystemDirectoryHandle,
  listing: DirectoryListing,
  entries: ChapterEntry[],
  opts: { details: boolean; chapters: boolean },
): Promise<LocalMetadata> {
  const empty: LocalMetadata = { details: {}, chapters: new Map() }
  if (!opts.details && !opts.chapters) return empty

  const skipXml = await hasNoXmlMarker(series)

  const top = skipXml ? null : await readTopLevelComicInfo(listing)
  const details = top
    ? seriesDetailsOf(top)
    : opts.details
      ? await readDetails(listing)
      : {}

  // Without chapter titles to fetch, the archives are only worth opening when
  // they are the last place a series description could come from.
  const needsFallback = opts.details && !top && isEmpty(details)
  if (skipXml || (!opts.chapters && !needsFallback)) {
    return { details, chapters: new Map() }
  }

  const found = await scanChapters(seriesName, entries, opts.chapters)

  const chapters = new Map<string, ComicInfoChapter>()
  for (const [entryName, metadata] of found) {
    chapters.set(entryName, metadata.chapter)
  }

  return {
    details: needsFallback ? firstSeriesDetails(entries, found) : details,
    chapters,
  }
}

// -------------------------------------------------------------- selection --

/**
 * The series half of a top-level file, where `<Title>` is the series' own
 * title rather than a chapter's and so may stand in for a missing `<Series>`.
 */
function seriesDetailsOf(metadata: ComicInfoMetadata): LocalDetails {
  return {
    ...metadata.series,
    title: metadata.series.title ?? metadata.chapter.name,
  }
}

/**
 * Series details from the first chapter that has any, in chapter order.
 *
 * Mihon copies that chapter's file up to the series folder and reads it from
 * there ever after; reading it in place costs the same and leaves the folder
 * untouched. `<Title>` is not promoted here: in a chapter archive it names the
 * chapter.
 */
function firstSeriesDetails(
  entries: ChapterEntry[],
  found: Map<string, ComicInfoMetadata>,
): LocalDetails {
  for (const entry of entries) {
    const metadata = found.get(entry.entryName)
    if (metadata && !isEmpty(metadata.series)) return metadata.series
  }
  return {}
}

function isEmpty(details: LocalDetails): boolean {
  return !Object.values(details).some(Boolean)
}

// ------------------------------------------------------------------ reads --

async function hasNoXmlMarker(
  series: FileSystemDirectoryHandle,
): Promise<boolean> {
  // Hidden entries are dropped from directory listings, so the marker has to
  // be asked for by name.
  return await series
    .getFileHandle(NO_XML_FILE)
    .then(() => true)
    .catch(() => false)
}

async function readTopLevelComicInfo(
  listing: DirectoryListing,
): Promise<ComicInfoMetadata | null> {
  const wanted = COMIC_INFO_FILE.toLowerCase()
  for (const [name, handle] of listing.files) {
    if (name.toLowerCase() !== wanted) continue
    try {
      return parseComicInfo(await (await handle.getFile()).text())
    } catch {
      return null
    }
  }
  return null
}

/**
 * Chapter metadata, for as many chapters as the caller has a use for.
 *
 * `full` distinguishes the series screen, which needs every chapter's title,
 * from a details-only refresh that just needs somewhere to find a description.
 */
async function scanChapters(
  seriesName: string,
  entries: ChapterEntry[],
  full: boolean,
): Promise<Map<string, ComicInfoMetadata>> {
  const found = new Map<string, ComicInfoMetadata>()

  const candidates = entries.filter((entry) => entry.kind !== 'unsupported')
  if (candidates.length === 0 || barren.has(seriesName)) return found

  const collect = async (entry: ChapterEntry) => {
    const metadata = await readChapterComicInfo(seriesName, entry)
    if (metadata) found.set(entry.entryName, metadata)
  }

  // The probe is what a library of plain zips pays: five reads, once, and then
  // the series is left alone for the rest of the session.
  await eachLimited(candidates.slice(0, PROBE_LIMIT), collect)
  if (found.size === 0) {
    barren.add(seriesName)
    return found
  }

  if (full) await eachLimited(candidates.slice(PROBE_LIMIT), collect)
  return found
}

async function readChapterComicInfo(
  seriesName: string,
  entry: ChapterEntry,
): Promise<ComicInfoMetadata | null> {
  const key = `${seriesName}/${entry.entryName}`
  const cached = parsed.get(key)
  if (cached !== undefined) return cached

  let metadata: ComicInfoMetadata | null = null
  try {
    const text =
      entry.kind === 'directory'
        ? await readDirectoryComicInfo(entry.handle as FileSystemDirectoryHandle)
        : await readArchiveEntryText(
            await (entry.handle as FileSystemFileHandle).getFile(),
            COMIC_INFO_FILE,
          )
    metadata = text ? parseComicInfo(text) : null
  } catch {
    // An archive that will not open is a chapter without metadata, not a
    // failed series. Caching the null keeps the failure from repeating.
    metadata = null
  }

  remember(key, metadata)
  return metadata
}

/**
 * A chapter folder's own file, asked for by name rather than by listing the
 * folder: the listing costs a full scan of the chapter's images.
 */
async function readDirectoryComicInfo(
  handle: FileSystemDirectoryHandle,
): Promise<string | null> {
  const file = await handle.getFileHandle(COMIC_INFO_FILE).catch(() => null)
  return file ? await (await file.getFile()).text() : null
}

function remember(key: string, metadata: ComicInfoMetadata | null): void {
  if (parsed.size >= CACHE_LIMIT) {
    const oldest = parsed.keys().next()
    if (!oldest.done) parsed.delete(oldest.value)
  }
  parsed.set(key, metadata)
}

/** Runs `task` over `items`, `READ_CONCURRENCY` of them in flight at a time. */
async function eachLimited<T>(
  items: T[],
  task: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(READ_CONCURRENCY, items.length) },
    async () => {
      while (cursor < items.length) await task(items[cursor++])
    },
  )
  await Promise.all(workers)
}
