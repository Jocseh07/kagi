import { listSources, getSource } from '@/lib/sources/registry'
import { isConfigurable, kindOf } from '@/lib/sources/types'
import type { Source, FilterList, MangasPage, SManga } from '@/lib/sources/types'
import { getFlag } from '@/lib/db/repositories'
import { rememberManga, sourceOf } from '../services/library'
import type { Params, Field, Row, Section } from '../protocol'
import { string, number } from '../protocol'
import { action, field, section, navigate } from './helpers'

const filterLists = new Map<string, FilterList>()
const filterData = new Map<string, unknown>()

export function sourceBadge(source: Source): string[] {
  return source.contentRating === 'safe' ? [] : [source.contentRating === 'mixed' ? 'Mixed' : 'Adult']
}

export function mangaRow(source: Source, manga: SManga): Row {
  rememberManga(source.id, manga)
  return {
    id: `${source.id}:${manga.url}`, title: manga.title,
    subtitle: `${source.name} · ${kindOf(source) === 'novel' ? 'Novel' : 'Comic'}`,
    badges: sourceBadge(source),
    ...(manga.thumbnailUrl ? { imageRef: { sourceId: source.id, url: manga.thumbnailUrl } } : {}),
    actions: [navigate('Open series', 'series', { sourceId: source.id, url: manga.url }, true)],
  }
}

export async function browseSections(p: Params): Promise<Section[]> {
  const hideRated = await getFlag('browse.hideAdultSources')
  const kind = string(p.kind)
  const query = string(p.query).trim()
  const sources = listSources().filter((source) => !kind || kindOf(source) === kind)
  const fields: Field[] = [
    field('query', 'Search all sources', query),
    field('kind', 'Content', kind, 'select', [{ value: '', label: 'All' }, { value: 'comic', label: 'Comics' }, { value: 'novel', label: 'Novels' }]),
  ]
  const result: Section[] = [{
    id: 'browse-search', title: 'Find a comic or novel', status: 'ready', layout: 'form', fields,
    actions: [action('Search sources', 'browse.search'), action('Import local files', 'local.import', {}, { variant: 'secondary', pick: 'file', accept: ['cbz', 'zip', 'epub', 'txt', 'text'] }), action('Open comic folder', 'local.folder', {}, { variant: 'secondary', pick: 'folder' })],
  }]
  if (query) {
    return [...result, ...sources.map((source): Section => ({ id: `search:${source.id}`, title: source.name, status: 'loading', rows: [], layout: 'grid', empty: `No matching titles on ${source.name}.` }))]
  }
  const shown = sources.filter((source) => !hideRated || source.contentRating === 'safe')
  result.push(section('sources', 'Sources', shown.map((source): Row => ({
    id: source.id, title: source.name, subtitle: `${kindOf(source) === 'novel' ? 'Novels' : 'Comics'}${source.isLocal ? ' · On this device' : ''}`,
    badges: sourceBadge(source), actions: [navigate('Browse source', 'source', { sourceId: source.id }, true), ...(isConfigurable(source) ? [action('Source preferences', 'source.preferences', { sourceId: source.id }, { variant: 'secondary' })] : [])],
  })), 'No sources match this content filter.', [navigate('Show all sources', 'browse')]))
  return result
}

export async function globalSourceResults(source: Source, query: string, signal: AbortSignal): Promise<Section> {
  const configured = await sourceOf(source.id)
  const filters = configured.getFilterList()
  const results = await configured.getSearchMangaList(1, query, filters, signal)
  signal.throwIfAborted()
  return section(`search:${source.id}`, source.name, results.mangas.map((manga) => mangaRow(source, manga)), `No matching titles on ${source.name}.`, results.hasNextPage ? [navigate('More results', 'source', { sourceId: source.id, query, page: 2 })] : undefined, 'grid')
}

function filterFields(filters: FilterList, prefix = 'filter'): Field[] {
  return filters.flatMap((entry, index): Field[] => {
    const id = `${prefix}.${index}`
    switch (entry.type) {
      case 'header':
      case 'separator': return []
      case 'group': return filterFields(entry.state, id).map((item) => ({ ...item, label: `${entry.name}: ${item.label}` }))
      case 'text': return [field(id, entry.name, entry.state)]
      case 'checkbox': return [field(id, entry.name, entry.state, 'toggle')]
      case 'select': return [field(id, entry.name, entry.state, 'select', entry.values.map((label, value) => ({ value: String(value), label })))]
      case 'tristate': return [field(id, entry.name, entry.state, 'select', [{ value: '0', label: 'Any' }, { value: '1', label: 'Include' }, { value: '2', label: 'Exclude' }])]
      case 'sort': return [field(id, entry.name, entry.state.index, 'select', entry.values.map((label, value) => ({ value: String(value), label }))), field(`${id}.ascending`, `${entry.name}: ascending`, entry.state.ascending, 'toggle')]
    }
  })
}

export async function sourceFilterSection(p: Params, signal: AbortSignal): Promise<Section> {
  signal.throwIfAborted()
  const source = await sourceOf(string(p.sourceId))
  signal.throwIfAborted()
  let data: unknown
  if (source.supportsFilterFetching && source.fetchFilterData) {
    if (filterData.has(source.id)) data = filterData.get(source.id)
    else {
      data = await source.fetchFilterData(signal)
      signal.throwIfAborted()
      if (!filterData.has(source.id)) filterData.set(source.id, data)
    }
  }
  let filters = filterLists.get(source.id)
  if (!filters) {
    filters = source.getFilterList(data)
    filterLists.set(source.id, filters)
  }
  return {
    id: 'source-filters', title: 'Search and filters', status: 'ready', layout: 'form',
    fields: [field('query', 'Search this source', string(p.query)), ...filterFields(filters)],
    actions: [action('Apply search', 'source.filter', { sourceId: source.id }), navigate('Reset filters', 'source', { sourceId: source.id, reset: true }), ...(isConfigurable(source) ? [action('Source preferences', 'source.preferences', { sourceId: source.id }, { variant: 'secondary' })] : [])],
  }
}

export function getSourceFilters(sourceId: string): FilterList {
  return filterLists.get(sourceId) ?? getSource(sourceId).getFilterList()
}

export function setSourceFilters(sourceId: string, filters: FilterList): void {
  filterLists.set(sourceId, filters)
}

export async function sourceResults(p: Params, signal: AbortSignal): Promise<Section> {
  const source = await sourceOf(string(p.sourceId))
  if (p.reset === true) filterLists.delete(source.id)
  const page = Math.max(1, Math.trunc(number(p.page, 1)))
  const query = string(p.query).trim()
  let results: MangasPage
  if (query || p.filtered === true) results = await source.getSearchMangaList(page, query, getSourceFilters(source.id), signal)
  else if (p.feed === 'latest' && source.supportsLatest) results = await source.getLatestUpdates(page, signal)
  else if (p.feed === 'hot' && source.getHotManga) results = await source.getHotManga(page, signal)
  else results = await source.getPopularManga(page, signal)
  signal.throwIfAborted()
  const paging = [
    ...(page > 1 ? [navigate('Previous page', 'source', { ...p, page: page - 1 })] : []),
    ...(results.hasNextPage ? [navigate('Next page', 'source', { ...p, page: page + 1 })] : []),
  ]
  return section('source-results', `Page ${page}`, results.mangas.map((manga) => mangaRow(source, manga)), 'No titles match these filters.', paging, 'grid')
}
