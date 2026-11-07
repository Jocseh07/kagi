import { listChapters } from '@/lib/db/repositories'
import { listQueue, getQueueSummary } from '@/lib/download/queue-repository'
import { queueManager } from '@/lib/download/queue-manager'
import { isTextSource } from '@/lib/sources/types'
import { getSource } from '@/lib/sources/registry'
import { isIncognito } from '@/lib/incognito/store'
import type { Params, Section, Row } from '../protocol'
import { string } from '../protocol'
import { chapterRows } from './library'
import { sourceBadge, mangaRow } from './sources'
import { sourceOf, sourceManga, mangaOf, refreshManga } from '../services/library'
import { action, field, section, navigate, bytes } from './helpers'

export async function seriesSections(p: Params, signal: AbortSignal): Promise<Section[]> {
  let manga = await mangaOf(p)
  let chapters = await listChapters(manga.id)
  if (!chapters.length) {
    manga = await refreshManga(manga, signal)
    chapters = await listChapters(manga.id)
  }
  const source = getSource(manga.sourceId)
  const groups = [...new Set(chapters.map((chapter) => chapter.scanlator ?? ''))]
  return [
    section('series-info', 'About this series', [
      { id: 'series-description', title: manga.title, subtitle: [manga.author, manga.artist].filter(Boolean).join(' · '), detail: manga.description ?? 'No description was provided.', ...(manga.thumbnailUrl ? { imageRef: { sourceId: source.id, url: manga.thumbnailUrl } } : {}), badges: manga.genres ?? [], actions: [
        action(manga.favorite ? 'Remove from library' : 'Add to library', 'series.favorite', { mangaId: manga.id, favorite: !manga.favorite }, { variant: manga.favorite ? 'secondary' : 'primary' }),
        ...(manga.favorite ? [action('Assign categories', 'library.categories', { mangaId: manga.id }, { variant: 'secondary' }), navigate('Migrate source', 'migrate', { mangaId: manga.id })] : []),
        ...(!source.isLocal ? [action('Save unread chapters', 'series.saveUnread', { mangaId: manga.id }, { variant: 'secondary', cancelable: true })] : []),
        ...(isTextSource(source) ? [action('Create adaptation', 'adapt.create.dialog', { mangaId: manga.id }, { variant: 'secondary' })] : []),
        ...(!source.isLocal ? [action('Open original site', 'series.external', { mangaId: manga.id }, { variant: 'ghost' })] : []),
      ] },
      { id: 'series-source', title: source.name, subtitle: `${manga.contentKind === 'novel' ? 'Novel' : 'Comic'} · ${manga.status}`, badges: sourceBadge(source), actions: [navigate('Browse source', 'source', { sourceId: source.id })] },
    ], ''),
    { id: 'chapter-filters', title: 'Chapter filters', status: 'ready', layout: 'form', fields: [
      field('query', 'Search chapters', string(p.query)),
      field('chapterFilter', 'Show chapters', string(p.chapterFilter), 'select', [{ value: '', label: 'All chapters' }, { value: 'unread', label: 'Unread' }, { value: 'saved', label: 'Saved offline' }, { value: 'bookmarked', label: 'Bookmarked' }]),
      field('scanlator', 'Scanlation group', string(p.scanlator), 'select', [{ value: '', label: 'All groups' }, ...groups.filter(Boolean).map((name) => ({ value: name, label: name }))]),
      field('order', 'Sort by', string(p.order, 'number'), 'select', [{ value: 'number', label: 'Chapter number' }, { value: 'upload', label: 'Upload date' }]),
      field('ascending', 'Oldest first', p.ascending !== 'false', 'toggle'),
    ], actions: [action('Apply chapter filters', 'series.filter', { mangaId: manga.id }), action('Refresh chapters', 'series.refresh', { mangaId: manga.id }, { variant: 'secondary', cancelable: true })] },
    section('chapters', `${chapters.length} chapters`, await chapterRows(manga.id, p), 'No chapters match these filters.'),
  ]
}

export async function relatedSection(p: Params, signal: AbortSignal): Promise<Section> {
  signal.throwIfAborted()
  const manga = await mangaOf(p)
  const source = await sourceOf(manga.sourceId)
  if (!source.supportsRelatedMangas || !source.getRelatedMangaList) return section('related', 'Related series', [], 'This source does not list related series.')
  signal.throwIfAborted()
  const related = await source.getRelatedMangaList(sourceManga(manga), signal)
  signal.throwIfAborted()
  return section('related', 'Related series', related.map((entry) => mangaRow(source, entry)), 'No related series were provided.', undefined, 'grid')
}

export async function readerControls(p: Params): Promise<Section> {
  const manga = await mangaOf(p)
  const chapters = await listChapters(manga.id)
  const chapter = p.chapterId ? chapters.find((entry) => entry.id === p.chapterId) : chapters.find((entry) => entry.url === p.chapterUrl) ?? chapters.find((entry) => !entry.read) ?? chapters[0]
  return { id: 'reader-content', title: chapter?.name ?? 'Choose a chapter', status: 'ready', layout: 'form', fields: [field('chapterId', 'Chapter', chapter?.id ?? '', 'select', chapters.map((entry) => ({ value: entry.id, label: entry.name })))], actions: [
    action('Open selected chapter', 'reader.chapter'), navigate('Back to series', 'series', { mangaId: manga.id }), navigate('Reader settings', 'settings', { tab: 'reader' }),
    ...(chapter ? [action('Previous chapter', 'reader.previous', { chapterId: chapter.id }, { variant: 'secondary' }), action('Next chapter', 'reader.next', { chapterId: chapter.id }, { variant: 'primary' }), action('Restart chapter', 'reader.restart', {}, { variant: 'ghost' }), action(chapter.bookmarked ? 'Remove bookmark' : 'Bookmark chapter', 'chapter.bookmark', { chapterId: chapter.id, bookmarked: !chapter.bookmarked }, { variant: 'ghost' })] : []),
    action(isIncognito() ? 'Stop incognito reading' : 'Read incognito', 'reader.incognito', {}, { variant: 'ghost' }),
  ] }
}

export async function downloadsSection(): Promise<Section[]> {
  const [items, summary] = await Promise.all([listQueue(), getQueueSummary()])
  const runtime = queueManager.getSnapshot()
  const rows: Row[] = items.map((item, index) => ({
    id: item.id, title: `${item.mangaTitle} · ${item.chapterName}`, subtitle: item.lastError ?? `${item.state} · ${item.pagesCompleted}${item.pagesTotal ? ` of ${item.pagesTotal}` : ''} pages`,
    ...(item.pagesTotal ? { progress: item.pagesCompleted / item.pagesTotal } : {}),
    actions: [
      ...(item.state === 'done' ? [navigate('Read chapter', 'reader', { mangaId: item.mangaId, chapterId: item.chapterId }, true)] : []),
      ...(item.state === 'active' || item.state === 'queued' ? [action('Pause chapter', 'downloads.item.pause', { queueId: item.id }, { variant: 'secondary' })] : []),
      ...(item.state === 'paused' ? [action('Resume chapter', 'downloads.item.resume', { queueId: item.id }, { variant: 'primary' })] : []),
      ...(item.state === 'failed' || item.state === 'cancelled' ? [action('Retry chapter', 'downloads.retry', { queueId: item.id }, { variant: 'primary' })] : []),
      ...(index > 0 && item.state !== 'done' ? [action('Move earlier', 'downloads.move', { queueId: item.id, position: index - 1 }, { variant: 'ghost' })] : []),
      action('Remove from queue', 'downloads.remove', { queueId: item.id }, { variant: 'ghost' }),
    ],
  }))
  return [section('download-status', 'Queue status', [{ id: 'queue-summary', title: `${summary.counts.active} downloading · ${summary.counts.queued} queued · ${summary.counts.done} finished`, subtitle: runtime.halt?.message ?? `${bytes(summary.projectedBytes)} estimated for unfinished chapters`, actions: [action('Pause queue', 'downloads.pause', {}, { variant: 'secondary' }), action('Resume queue', 'downloads.resume'), action('Clear finished entries', 'downloads.clearFinished', {}, { variant: 'ghost' }), navigate('Download settings', 'settings', { tab: 'downloads' })] }], ''), section('download-queue', 'Chapters', rows, 'Choose chapters from your library to save them offline.', [navigate('Open library', 'library')])]
}
