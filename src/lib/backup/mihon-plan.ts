/**
 * What an import *would* do, decided before anything is written.
 *
 * Deliberately free of database imports: the settings panel shows this before
 * the user commits, and the report script under `scripts/` runs the very same
 * code against a real `.tachibk` outside a browser. Sharing it is the point —
 * a preview computed by different code from the write is a preview that lies.
 */

import { parseMihonBackup } from './mihon'
import type { MihonBackup } from './mihon'
import {
  mapManga,
  resolveSources,
  sourceLabel,
  sourceNames,
} from './mihon-mapping'
import type { MappedManga, SupportedSourceId } from './mihon-mapping'

export type SkipReason = 'unsupported-source' | 'unreadable-url'

/** One series the import will not bring in, and what is being left behind. */
export interface SkippedSeries {
  title: string
  /** The name the backup gives its source, or the raw id when it gives none. */
  sourceName: string
  chapters: number
  readChapters: number
  reason: SkipReason
}

/** A supported source's share of the backup. */
export interface ImportableSource {
  sourceId: SupportedSourceId
  sourceName: string
  series: number
  favorites: number
  chapters: number
  readChapters: number
  /** Chapters inside these series whose url this source could not address. */
  skippedChapters: number
}

export interface MihonImportPlan {
  sources: ImportableSource[]
  skipped: SkippedSeries[]
  totalSeries: number
  totalChapters: number
  categories: string[]
  /** Prepared rows, carried into `runMihonImport` so parsing happens once. */
  readonly entries: readonly MappedManga[]
}

/** Reads the file and works out what an import would do, writing nothing. */
export async function planMihonImport(
  bytes: Uint8Array,
): Promise<MihonImportPlan> {
  return planFromBackup(await parseMihonBackup(bytes))
}

export function planFromBackup(backup: MihonBackup): MihonImportPlan {
  const supported = resolveSources(backup)
  const names = sourceNames(backup)

  const entries: MappedManga[] = []
  const skipped: SkippedSeries[] = []
  const totals = new Map<SupportedSourceId, ImportableSource>()

  for (const manga of backup.manga) {
    const sourceId = supported.get(manga.sourceId)
    const sourceName =
      names.get(manga.sourceId) ?? `Unknown source ${manga.sourceId}`
    const mapped = sourceId ? mapManga(manga, sourceId) : null

    if (!sourceId || !mapped) {
      skipped.push({
        title: manga.title || manga.url,
        sourceName,
        chapters: manga.chapters.length,
        readChapters: manga.chapters.filter((chapter) => chapter.read).length,
        reason: sourceId ? 'unreadable-url' : 'unsupported-source',
      })
      continue
    }

    entries.push(mapped)

    const running = totals.get(sourceId) ?? {
      sourceId,
      sourceName: sourceLabel(sourceId),
      series: 0,
      favorites: 0,
      chapters: 0,
      readChapters: 0,
      skippedChapters: 0,
    }
    running.series += 1
    if (mapped.favorite) running.favorites += 1
    running.chapters += mapped.chapters.length
    running.readChapters += mapped.chapters.filter((c) => c.read).length
    running.skippedChapters += mapped.skippedChapters
    totals.set(sourceId, running)
  }

  return {
    sources: [...totals.values()].sort((a, b) => b.series - a.series),
    skipped: skipped.sort(
      (a, b) => b.chapters - a.chapters || a.title.localeCompare(b.title),
    ),
    totalSeries: backup.manga.length,
    totalChapters: backup.manga.reduce((n, m) => n + m.chapters.length, 0),
    categories: backup.categories.map((category) => category.name),
    entries,
  }
}

/** Everything the import will not touch, grouped by the source it came from. */
export function groupSkipped(
  skipped: readonly SkippedSeries[],
): { sourceName: string; chapters: number; readChapters: number; series: SkippedSeries[] }[] {
  const groups = new Map<string, SkippedSeries[]>()
  for (const entry of skipped) {
    const list = groups.get(entry.sourceName)
    if (list) list.push(entry)
    else groups.set(entry.sourceName, [entry])
  }

  return [...groups.entries()]
    .map(([sourceName, series]) => ({
      sourceName,
      series,
      chapters: series.reduce((n, e) => n + e.chapters, 0),
      readChapters: series.reduce((n, e) => n + e.readChapters, 0),
    }))
    .sort((a, b) => b.series.length - a.series.length)
}
