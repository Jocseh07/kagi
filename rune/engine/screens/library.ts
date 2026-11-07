import * as repository from '@/lib/db/repositories'
import { queryLibraryCards, DEFAULT_LIBRARY_FILTERS, DEFAULT_LIBRARY_SORT } from '@/lib/db/library'
import type { LibraryQueryOptions, LibrarySortKey, LibraryFilters } from '@/lib/db/library'
import * as categories from '@/lib/db/categories'
import * as home from '@/lib/db/home'
import * as history from '@/lib/db/history'
import * as updates from '@/lib/db/updates'
import { getSource } from '@/lib/sources/registry'
import { librarySelection } from '../services/library'
import type { Params, Section, Row, Field } from '../protocol'
import { string, number } from '../protocol'
import { action, navigate, field, section, tabs, date } from './helpers'

export const homeTabs = (p: Params) => tabs('home', string(p.tab, 'reading'), [['reading', 'Reading'], ['added', 'Added']])

function sourceLabel(sourceId: string): string {
  const source = getSource(sourceId)
  return `${source.name}${source.contentRating === 'safe' ? '' : source.contentRating === 'mixed' ? ' · Mixed' : ' · Adult'}`
}

export async function homeSections(p: Params): Promise<Section[]> {
  if (string(p.tab) === 'added') {
    const [progress, continuing] = await Promise.all([home.listLibraryProgress(), home.listContinueItems(50)])
    const groups = home.groupLibraryForHome(progress, new Set(continuing.map((item) => item.history.mangaId)))
    return ([['notStarted', 'Not started'], ['paused', 'Paused'], ['caughtUp', 'Caught up']] as const).map(([key, title]) => section(key, title,
      groups[key].map((item): Row => ({ id: item.id, title: item.title, subtitle: `${item.unreadCount} unread · ${item.downloadedCount} saved`, actions: [navigate('Open series', 'series', { mangaId: item.id })] })),
      `No ${title.toLowerCase()} series.`, [navigate('Browse sources', 'browse')], 'grid'))
  }
  const [continuing, saved] = await Promise.all([home.listContinueItems(30), home.listSavedBySeries()])
  return [
    section('continue', 'Continue reading', continuing.map(({ history: item, target }): Row => ({
      id: item.mangaId, title: item.mangaTitle, subtitle: `${target.name} · ${sourceLabel(item.sourceId)}`,
      progress: target.pageCount > 0 ? Math.min(1, target.lastPageRead / target.pageCount) : 0,
      actions: [navigate('Continue reading', 'reader', { mangaId: item.mangaId, chapterUrl: target.url }, true), navigate('Open series', 'series', { mangaId: item.mangaId })],
    })), 'Open a chapter to continue reading here.', [navigate('Browse sources', 'browse')], 'grid'),
    section('saved', 'Saved for offline', saved.map((item): Row => ({ id: item.mangaId, title: item.title, subtitle: `${item.savedCount} saved chapters`, actions: [navigate('Read offline', 'series', { mangaId: item.mangaId, saved: '1' })] })), 'Save chapters to read without a connection.', [navigate('Open library', 'library')], 'grid'),
  ]
}

const sortKeys: LibrarySortKey[] = ['alphabetical', 'lastRead', 'lastChecked', 'unreadCount', 'totalChapters', 'latestChapter', 'dateAdded', 'random']
const sortLabels = ['Title', 'Last read', 'Last checked', 'Unread chapters', 'Total chapters', 'Latest chapter', 'Date added', 'Random']

export async function librarySections(p: Params): Promise<Section[]> {
  const filters = { ...DEFAULT_LIBRARY_FILTERS }
  for (const key of Object.keys(filters) as (keyof LibraryFilters)[]) {
    const value = number(p[key])
    filters[key] = value === 1 ? 1 : value === 2 ? 2 : 0
  }
  const requestedSort = string(p.sort, DEFAULT_LIBRARY_SORT.key)
  const sort = sortKeys.find((key) => key === requestedSort) ?? DEFAULT_LIBRARY_SORT.key
  const kind = p.kind === 'comic' || p.kind === 'novel' ? p.kind : undefined
  const options: LibraryQueryOptions = {
    filters, sort: { key: sort, ascending: p.ascending !== 'false' }, search: string(p.query),
    ...(kind ? { kind } : {}), categoryId: string(p.categoryId) || null,
    randomSeed: number(p.seed, 429),
  }
  const [cards, allCategories] = await Promise.all([queryLibraryCards(options), categories.listCategories()])
  const fields: Field[] = [
    field('query', 'Search library', string(p.query)),
    field('kind', 'Content', string(p.kind), 'select', [{ value: '', label: 'All' }, { value: 'comic', label: 'Comics' }, { value: 'novel', label: 'Novels' }]),
    field('categoryId', 'Category', string(p.categoryId), 'select', [{ value: '', label: 'All categories' }, ...allCategories.map((entry) => ({ value: entry.id, label: entry.name }))]),
    field('sort', 'Sort by', sort, 'select', sortKeys.map((key, index) => ({ value: key, label: sortLabels[index] }))),
    field('ascending', 'Ascending order', p.ascending !== 'false', 'toggle'),
    field('display', 'Display', string(p.display, 'grid'), 'select', [{ value: 'grid', label: 'Covers' }, { value: 'list', label: 'Compact list' }]),
    ...(['downloaded', 'unread', 'started', 'bookmarked', 'completed'] as const).map((key) => field(key, ({ downloaded: 'Saved offline', unread: 'Unread', started: 'Started', bookmarked: 'Bookmarked', completed: 'Completed' })[key], filters[key], 'select', [{ value: '0', label: 'Any' }, { value: '1', label: 'Only matching' }, { value: '2', label: 'Exclude matching' }])),
  ]
  const bulk = librarySelection.size ? [
    action('Mark selected read', 'library.bulk', { operation: 'read' }),
    action('Mark selected unread', 'library.bulk', { operation: 'unread' }, { variant: 'secondary' }),
    action('Assign categories', 'library.categories', {}, { variant: 'secondary' }),
    action('Remove selected', 'library.bulk', { operation: 'remove' }, { variant: 'danger', confirm: `Remove ${librarySelection.size} selected series from your library? Saved chapters and history remain.` }),
    action('Clear selection', 'library.clearSelection', {}, { variant: 'ghost' }),
  ] : []
  return [
    { id: 'library-filters', title: 'Find a series', status: 'ready', layout: 'form', fields, actions: [action('Apply filters', 'library.filter'), navigate('Clear filters', 'library'), navigate('Manage categories', 'categories'), ...bulk] },
    section('library', `${cards.length} series${librarySelection.size ? ` · ${librarySelection.size} selected` : ''}`, cards.map((item): Row => ({
      id: item.id, title: item.title, subtitle: `${item.unreadCount} unread · ${item.downloadedCount} saved · ${sourceLabel(item.sourceId)}`,
      badges: getSource(item.sourceId).contentRating === 'safe' ? [] : [getSource(item.sourceId).contentRating === 'mixed' ? 'Mixed' : 'Adult'],
      selected: librarySelection.has(item.id),
      actions: [navigate('Open series', 'series', { mangaId: item.id }, true), action(librarySelection.has(item.id) ? 'Deselect series' : 'Select series', 'library.select', { mangaId: item.id }, { variant: 'ghost' })],
    })), string(p.query) || p.kind || p.categoryId ? 'No series match these filters.' : 'Your library is empty. Add a series from Browse.', [navigate('Browse sources', 'browse')], p.display === 'list' ? 'list' : 'grid'),
  ]
}

export async function categorySections(): Promise<Section[]> {
  const [list, counts] = await Promise.all([categories.listCategories(), categories.getCategoryCounts()])
  return [section('categories', 'Your categories', list.map((item, index): Row => ({
    id: item.id, title: item.name, subtitle: `${counts[item.id] ?? 0} series`,
    actions: [
      navigate('View series', 'library', { categoryId: item.id }),
      action('Rename category', 'category.edit', { categoryId: item.id }, { variant: 'secondary' }),
      ...(index > 0 ? [action('Move earlier', 'category.move', { categoryId: item.id, direction: -1 }, { variant: 'ghost' })] : []),
      ...(index < list.length - 1 ? [action('Move later', 'category.move', { categoryId: item.id, direction: 1 }, { variant: 'ghost' })] : []),
      action('Delete category', 'category.delete', { categoryId: item.id }, { variant: 'danger', confirm: `Delete “${item.name}”? Its series stay in your library.` }),
    ],
  })), 'Create a category to organize your library.', [action('Add category', 'category.edit')])]
}

export async function historySections(): Promise<Section[]> {
  const list = await history.listHistory(1000)
  return [section('history', 'Recently opened', list.map((item): Row => ({
    id: item.id, title: item.mangaTitle, subtitle: `${item.chapterName} · ${date(item.readAt)}`,
    actions: [navigate('Continue reading', 'reader', { mangaId: item.mangaId, chapterId: item.chapterId }, true), action('Remove entry', 'history.remove', { historyId: item.id }, { variant: 'ghost' })],
  })), 'Your reading history appears after you open a chapter.', [navigate('Browse library', 'library'), action('Clear history', 'history.clear', {}, { variant: 'danger', confirm: 'Clear your reading history? Chapter read states stay unchanged.' })])]
}

export async function updateSections(): Promise<Section[]> {
  const list = await updates.listRecentChapters(2000)
  return [section('updates', 'New chapters', list.map((item): Row => ({
    id: item.chapterId, title: item.mangaTitle, subtitle: `${item.chapterName} · ${date(item.dateUpload)}`,
    actions: [navigate('Read chapter', 'reader', { mangaId: item.mangaId, chapterId: item.chapterId }, true), action('Save chapter', 'chapter.save', { chapterId: item.chapterId }, { variant: 'secondary' })],
  })), 'No new chapters found. Check your library for updates.', [action('Check updates', 'updates.start'), action('Cancel update', 'updates.cancel', {}, { variant: 'secondary' })])]
}

export async function chapterRows(mangaId: string, p: Params): Promise<Row[]> {
  const list = await repository.listChapters(mangaId)
  const query = string(p.query).toLocaleLowerCase()
  const filtered = list.filter((chapter) => {
    if (query && !chapter.name.toLocaleLowerCase().includes(query)) return false
    if (p.scanlator && (chapter.scanlator ?? '') !== p.scanlator) return false
    if (p.chapterFilter === 'unread' && chapter.read) return false
    if (p.chapterFilter === 'saved' && !chapter.downloaded) return false
    if (p.chapterFilter === 'bookmarked' && !chapter.bookmarked) return false
    return true
  }).sort((a, b) => p.order === 'upload' ? (a.dateUpload ?? 0) - (b.dateUpload ?? 0) : a.chapterNumber - b.chapterNumber)
  if (p.ascending === 'false') filtered.reverse()
  return filtered.map((chapter): Row => ({
    id: chapter.id, title: chapter.name,
    subtitle: `${chapter.read ? 'Read' : 'Unread'}${chapter.downloaded ? ' · Saved offline' : ''}${chapter.scanlator ? ` · ${chapter.scanlator}` : ''}`,
    badges: chapter.bookmarked ? ['Bookmarked'] : [],
    actions: [
      navigate('Read chapter', 'reader', { mangaId, chapterId: chapter.id }, true),
      action(chapter.read ? 'Mark unread' : 'Mark read', 'chapter.read', { chapterId: chapter.id, read: !chapter.read }, { variant: 'ghost' }),
      action(chapter.bookmarked ? 'Remove bookmark' : 'Bookmark chapter', 'chapter.bookmark', { chapterId: chapter.id, bookmarked: !chapter.bookmarked }, { variant: 'ghost' }),
      action(chapter.downloaded ? 'Remove saved copy' : 'Save chapter', chapter.downloaded ? 'chapter.unsave' : 'chapter.save', { chapterId: chapter.id }, { variant: chapter.downloaded ? 'danger' : 'secondary', ...(chapter.downloaded ? { confirm: 'Remove this saved chapter? Reading progress stays unchanged.' } : {}) }),
      action('Export chapter', 'chapter.export', { chapterId: chapter.id }, { variant: 'secondary', pick: 'save' }),
    ],
  }))
}
