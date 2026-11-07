import type { Action, Params, Section } from '../protocol'
import { string, number } from '../protocol'
import { action, bytes, field } from './helpers'
import { settingsGroup, adaptFields, appearanceFields, preferenceFields, profileFields, readerFields, readReaderPreferences, themePresets, storageBreakdown } from '../services/settings'
import { fontCatalogue } from '../services/fonts'
import { mihonReviewSections } from '../services/backups'
import { listSavedChapters, getManga } from '../../../src/lib/db/repositories'
import { exec } from '../adapters/database'
import { isIncognito } from '../../../src/lib/incognito/store'

function save(group: string, seriesId?: string): Action {
  return action('Save settings', 'settings.save', { group, tab: group, ...(seriesId ? { seriesId } : {}) }, { variant: 'primary' })
}
export async function settingsSections(p: Params, publish?: (section: Section) => void): Promise<Section[]> {
  const group = settingsGroup(p)
  async function scoped(id: string, title: string, load: () => Promise<Section>, group: string): Promise<Section> {
    let section: Section
    try { section = await load() }
    catch (error) {
      section = { id, title, status: 'error', error: error instanceof Error ? error.message : 'Settings could not load. Try again.', actions: [
        action('Reload settings', 'navigate', { route: 'settings', tab: group }),
        ...(group === 'adapt' ? [action('Reset connection', 'settings.adapt.reset-connection', { tab: 'adapt' }, { variant: 'danger', confirm: 'Remove this device’s endpoint and API key? Model selections remain.' })] : []),
      ] }
    }
    publish?.(section)
    return section
  }
  if (group === 'adapt') return [await scoped('adapt', 'Generation connection', async () => ({
    id: 'adapt', title: 'Generation connection', status: 'ready', layout: 'form', fields: await adaptFields(), actions: [
      save(group), action('Test connection', 'settings.adapt.test', { tab: group }),
      action('Remove API key', 'settings.adapt.clear-key', { tab: group }, { variant: 'danger', confirm: 'Remove the API key saved on this device?' }),
    ],
  }), group)]
  if (group === 'appearance') {
    return Promise.all([
      scoped('appearance', 'Appearance', async () => ({ id: 'appearance', title: 'Appearance', status: 'ready', layout: 'form', fields: await appearanceFields(), actions: [save(group), action('Refresh themes', 'theme.refresh', { tab: group })] }), group),
      scoped('theme-import', 'Import theme', async () => ({ id: 'theme-import', title: 'Import theme', status: 'ready', layout: 'form', fields: [field('title', 'Theme name', ''), field('css', 'Theme CSS or registry JSON', '', 'multiline')], actions: [
        action('Import pasted theme', 'theme.import', { tab: group }),
        action('Open theme file', 'theme.import', { tab: group }, { pick: 'file', accept: ['css', 'json'] }),
        action('Export theme JSON', 'theme.export', { tab: group, format: 'json' }, { pick: 'save', accept: ['json'] }),
        action('Export theme CSS', 'theme.export', { tab: group, format: 'css' }, { pick: 'save', accept: ['css'] }),
      ] }), group),
      scoped('custom-themes', 'Imported themes', async () => ({ id: 'custom-themes', title: 'Imported themes', status: 'ready', layout: 'list', empty: 'No imported themes. Paste CSS or open a theme file.', rows: (await themePresets()).filter((preset) => preset.source === 'custom').map((preset) => ({ id: preset.id, title: preset.title, actions: [
        action('Use theme', 'theme.select', { id: preset.id, tab: group }),
        action('Remove theme', 'theme.remove', { id: preset.id, tab: group }, { variant: 'danger', confirm: `Remove imported theme "${preset.title}"?` }),
      ] })) }), group),
      scoped('fonts', 'Font catalogue', async () => ({ id: 'fonts', title: 'Font catalogue', status: 'ready', layout: 'list', empty: 'No fonts found. Install a Google font.', rows: (await fontCatalogue()).map((font) => ({ id: font.id, title: font.name, detail: font.paths.length ? `${font.paths.length} font files` : 'Font assets not packaged', actions: [
        ...(font.paths.length ? [action('Use app font', 'fonts.select', { id: font.id, tab: group })] : []),
        ...(font.id.startsWith('gf:') ? [action('Remove font', 'fonts.remove', { id: font.id, tab: group }, { variant: 'danger', confirm: `Remove ${font.name} from this device?` })] : []),
      ] })) }), group),
      scoped('google-fonts', 'Google fonts', async () => ({ id: 'google-fonts', title: 'Google fonts', status: 'ready', layout: 'form', fields: [field('name', 'Family name', '', 'text', undefined, 'For example, Atkinson Hyperlegible')], actions: [
        action('Install font', 'fonts.install', { tab: group }),
        action('Clear unused cache', 'fonts.clear-cache', { tab: group }),
      ] }), group),
    ])
  }
  if (group === 'library') return Promise.all([
    scoped('library', 'Library updates', async () => ({ id: 'library', title: 'Library updates', status: 'ready', layout: 'form', fields: await preferenceFields('library'), actions: [save(group)] }), group),
    scoped('profile', 'Local profile', async () => ({ id: 'profile', title: 'Local profile', status: 'ready', layout: 'form', fields: await profileFields(), actions: [
      action('Save local profile', 'settings.profile.save', { tab: group }),
      action('Remove local profile', 'settings.profile.clear', { tab: group }, { variant: 'danger', confirm: 'Remove your local name, email, and avatar preference?' }),
    ] }), group),
    scoped('incognito', 'Reading privacy', async () => ({ id: 'incognito', title: 'Reading privacy', status: 'ready', layout: 'form', fields: [field('enabled', 'Incognito reading', isIncognito(), 'toggle', undefined, 'Do not save history or reading progress')], actions: [action('Save reading privacy', 'settings.incognito', { tab: group })] }), group),
  ])
  if (group === 'browse') return [await scoped('browse', 'Browse sources', async () => ({ id: 'browse', title: 'Browse sources', status: 'ready', layout: 'form', fields: await preferenceFields('browse'), actions: [save(group)] }), group)]
  if (group === 'reader') {
    const seriesId = string(p.seriesId)
    return Promise.all([
      scoped('reader', 'Reading preferences', async () => {
        const series = seriesId ? await getManga(seriesId) : null
        if (seriesId && !series) throw new Error('Series not found.')
        const saved = await readReaderPreferences(seriesId || undefined)
        return { id: 'reader', title: series ? `${series.title}: ${saved.overridden ? 'Series override' : 'Following global settings'}` : 'Every series', status: 'ready', layout: 'form', fields: await readerFields(seriesId || undefined), actions: [
          save(group, seriesId || undefined),
          action(seriesId ? 'Use global settings' : 'Reset novel typography', 'settings.reader.reset', { tab: group, ...(seriesId ? { seriesId } : {}) }),
        ] }
      }, group),
      scoped('reader-series', 'Per-series settings', async () => {
        const page = Math.max(0, Math.trunc(number(p.readerPage)))
        const search = string(p.readerSearch)
        const matches = await exec('SELECT id, title FROM manga WHERE favorite = 1 AND title LIKE ? ORDER BY title, id LIMIT 51 OFFSET ?', [`%${search}%`, page * 50])
        return {
          id: 'reader-series', title: 'Per-series settings', status: 'ready', layout: 'list',
          fields: [field('search', 'Find a library series', search)],
          rows: matches.rows.slice(0, 50).map((row) => ({ id: String(row[0]), title: String(row[1]), actions: [action('Edit reading settings', 'settings.reader.open', { tab: group, seriesId: String(row[0]) })] })),
          empty: search ? 'No series match. Clear your search.' : 'Add a series to your library to customize it.',
          actions: [
            action('Search library', 'settings.reader.search', { tab: group }),
            action('Open global settings', 'navigate', { route: 'settings', tab: group }),
            ...(page > 0 ? [action('Previous series', 'navigate', { route: 'settings', tab: group, readerSearch: search, readerPage: page - 1 })] : []),
            ...(matches.rows.length > 50 ? [action('Next series', 'navigate', { route: 'settings', tab: group, readerSearch: search, readerPage: page + 1 })] : []),
          ],
        }
      }, group),
    ])
  }
  if (group === 'downloads') return Promise.all([
    scoped('downloads', 'Download preferences', async () => ({ id: 'downloads', title: 'Download preferences', status: 'ready', layout: 'form', fields: await preferenceFields('downloads'), actions: [save(group)] }), group),
    scoped('saved-chapters', 'Saved chapters', async () => ({ id: 'saved-chapters', title: 'Saved chapters', status: 'ready', layout: 'list', empty: 'No saved chapters. Download chapters from a series.', rows: (await listSavedChapters()).map((chapter) => ({
      id: chapter.chapterId, title: chapter.mangaTitle, subtitle: chapter.chapterName, detail: bytes(chapter.measuredBytes ?? chapter.projectedBytes), actions: [
        action('Remove saved chapter', 'storage.unsave', { chapterId: chapter.chapterId, tab: group }),
        action('Remove series downloads', 'storage.unsave-series', { seriesId: chapter.mangaId, tab: group }, { variant: 'danger', confirm: `Remove every saved chapter of "${chapter.mangaTitle}"? Reading progress stays saved.` }),
      ],
    })), actions: [
      action('Remove read downloads', 'storage.unsave-read', { tab: group }),
      action('Remove all downloads', 'storage.clear', { bucket: 'saved-chapters', tab: group }, { variant: 'danger', confirm: 'Remove every offline chapter? Your reading progress stays saved.' }),
    ] }), group),
  ])
  return Promise.all([
    scoped('backup', 'Library backup', async () => ({ id: 'backup', title: 'Library backup', status: 'ready', layout: 'list', rows: [{ id: 'backup-scope', title: 'Database backup', subtitle: 'Offline pages, imported originals, fonts, journals, and credentials are not included.' }], actions: [
      action('Export database', 'backup.export', { tab: group }, { pick: 'save', accept: ['sqlite', 'db'] }),
      action('Restore database', 'backup.restore', { tab: group }, { pick: 'file', accept: ['sqlite', 'db'], variant: 'danger', confirm: 'Replace your current library with this backup? Running jobs will stop. Imported files are not restored.' }),
      action('Review Mihon backup', 'mihon.review', { tab: group }, { pick: 'file', accept: ['tachibk', 'proto', 'gz'] }),
    ] }), group),
    scoped('storage', 'Storage usage', async () => ({ id: 'storage', title: 'Storage usage', status: 'ready', layout: 'list', rows: (await storageBreakdown()).map((bucket) => ({ id: bucket.id, title: bucket.label, subtitle: bucket.detail, detail: bucket.includedInDatabase && bucket.bytes === 0 ? undefined : bytes(bucket.bytes), actions: bucket.clearable ? [
      action(bucket.id === 'preferences' ? 'Reset preferences' : 'Clear storage', 'storage.clear', { bucket: bucket.id, tab: group }, { variant: 'danger', confirm: bucket.id === 'library' ? 'Erase library entries, chapters, categories, history, and downloads? Imported originals and adaptations remain.' : bucket.id === 'imported-books' ? 'Delete imported books and comics, their library entries, and offline copies? External folders remain untouched.' : bucket.id === 'adaptations' ? 'Delete every adaptation, generated image, published entry, and adaptation journal record?' : bucket.id === 'journal' ? 'Delete every generation record and its saved artifacts?' : bucket.id === 'cache' ? 'Clear cached images? They will load again when needed.' : bucket.id === 'preferences' ? 'Reset themes, app font, reader mode, and the chosen local comic folder? Book files remain.' : 'Remove every saved chapter? Reading progress stays saved.' }),
    ] : [] })), actions: [action('Refresh storage usage', 'storage.refresh', { tab: group })] }), group),
  ]).then((sections) => [...sections, ...mihonReviewSections()])
}
