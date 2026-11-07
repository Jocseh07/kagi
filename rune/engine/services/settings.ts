import { lstat, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { AdaptSettings } from '../../../src/lib/adapt/settings'
import { ADAPT_DEFAULTS, GENERATION_MODES, CONCURRENCY_CHOICES, CHAPTERS_AT_ONCE_CHOICES, SCRIPTS_AHEAD_CHOICES, READ_AHEAD_CHOICES } from '../../../src/lib/adapt/settings-model'
import { listModels } from '../../../src/lib/adapt/client'
import { getSetting, getSettings, setSetting, getManga, listSavedChapters } from '../../../src/lib/db/repositories'
import { listCategories } from '../../../src/lib/db/categories'
import { DEFAULT_TEXT_SETTINGS, TEXT_SIZE_RANGE, TEXT_LINE_HEIGHT_RANGE, TEXT_WIDTH_RANGE, READER_MODES, READER_SURFACES, RESUME_BEHAVIORS, PAGE_FITS, WORD_START_STRENGTHS, DIM_AFTER_MS } from '../../../src/lib/reader/reader-settings'
import type { TextReaderSettings, ReaderMode, PageFit, ContinuousStyle, ReaderSurface, ResumeBehavior } from '../../../src/lib/reader/reader-settings'
import type { WordStartStrength } from '../../../src/lib/text/word-starts'
import { COMIC_CONCURRENCY_CHOICES, NOVEL_CONCURRENCY_CHOICES, MIN_MANGA_CONCURRENCY, MAX_MANGA_CONCURRENCY, DEFAULT_MANGA_CONCURRENCY, DEFAULT_QUEUE_CONCURRENCY, DEFAULT_NOVEL_CONCURRENCY, SETTING_QUEUE_CONCURRENCY, SETTING_NOVEL_CONCURRENCY, SETTING_MANGA_CONCURRENCY, SETTING_AUTO_CLEAR_FINISHED } from '../../../src/lib/download/queue-types'
import { SETTING_SAVED_CHAPTER_LIMIT, SETTING_DELETE_AFTER_READ, MAX_SAVED_CHAPTER_LIMIT } from '../../../src/lib/offline/types'
import { DEFAULT_UPDATE_PREFS, UPDATE_INTERVALS } from '../../../src/lib/updates/update-manager'
import { queueManager } from '../../../src/lib/download/queue-manager'
import { DEFAULT_PRESET } from '../../../src/lib/theme/default-preset'
import bundledPresets from '../../../src/lib/theme/presets.json'
import { sanitizeTokens, slugify, hasAnyToken } from '../../../src/lib/theme/tokens'
import type { ThemePreset } from '../../../src/lib/theme/tokens'
import { parseTheme, tokensToCss, tokensToRegistryItem } from '../../../src/lib/theme/css'
import { ACCENTS } from '../../../src/lib/profile/avatar-accent'
import { setIncognito } from '../../../src/lib/incognito/store'
import { getPreference, setPreference, setPreferences, deletePreference } from '../adapters/preferences'
import { readAdaptSettings, writeAdaptSetting, writeAdaptConnection } from '../adapters/settings'
import { exec, sqliteTransaction, databasePath, exclusive } from '../adapters/database'
import { isMissing, readBytes } from '../adapters/storage'
import { unsaveChapter, unsaveAllChapters, setSavedChapterLimit } from '../adapters/offline'
import { clearBooks, novelsRoot } from '../adapters/local-novel'
import { clearImportedComics, localFilesRoot, forgetLocalLibrary } from '../adapters/local-files'
import { clearAllAdaptations, adaptationsSize } from '../adapters/adapt-store'
import { clearImageCache, imageCacheRoot } from '../adapters/image-runtime'
import { journalRoot, journalStore } from '../adapters/journal-store'
import { configureFonts, fontCatalogue, installedFontFiles, installGoogleFont, removeGoogleFont, clearFontCache } from './fonts'
import { configureBackupMaintenance, exportLibraryBackup, restoreLibraryBackup, reviewMihonBackup, commitMihonImport, cancelMihonImport, withSettingsMaintenance, settingsExportDestination } from './backups'
import type { SettingsMaintenance } from './backups'
import { atomicExport } from './files'
import { settingsSections } from '../screens/settings'
import type { Choice, Field, Params, Result, Tab } from '../protocol'
import { string } from '../protocol'

export const SETTINGS_GROUPS = [
  ['adapt', 'Adapt'], ['appearance', 'Appearance'], ['library', 'Library'], ['browse', 'Browse'], ['reader', 'Reader'], ['downloads', 'Downloads'], ['data', 'Data'],
] as const
export type SettingsGroup = typeof SETTINGS_GROUPS[number][0]
let configuredRoot: string | undefined
let actionChain: Promise<unknown> = Promise.resolve()
export function configureSettings(root: string, assetsRoot?: string): void {
  configuredRoot = resolve(root)
  configureFonts(root, assetsRoot)
}
export function configureSettingsMaintenance(value: SettingsMaintenance): void { configureBackupMaintenance(value) }
export function settingsTabs(p: Params): Tab[] {
  const selected = string(p.tab, 'appearance')
  return SETTINGS_GROUPS.map(([id, label]) => ({ id, label, route: 'settings', params: { tab: id }, selected: id === selected }))
}
export function settingsGroup(p: Params): SettingsGroup {
  const selected = string(p.tab, string(p.group, 'appearance'))
  const found = SETTINGS_GROUPS.find(([id]) => id === selected)
  if (!found) throw new Error('Choose a settings group.')
  return found[0]
}
const options = (values: readonly (string | number)[]): Choice[] => values.map((value) => ({ value: String(value), label: String(value) }))
interface PreferenceField extends Field { range?: { min: number; max: number; integer?: boolean }; flag?: boolean }
function preference(id: string, label: string, value: string | number | boolean, kind: Field['kind'] = 'text', choices?: Choice[], range?: PreferenceField['range'], flag?: boolean): PreferenceField {
  return { id, label, value: String(value), kind, ...(choices ? { options: choices } : {}), ...(range ? { range } : {}), ...(flag ? { flag } : {}) }
}
const specs: Record<'library' | 'browse' | 'downloads', PreferenceField[]> = {
  library: [
    preference('updates.interval_hours', 'Update reminder', DEFAULT_UPDATE_PREFS.intervalHours, 'select', UPDATE_INTERVALS.map((hours) => ({ value: String(hours), label: hours === 0 ? 'Only when requested' : hours === 24 ? 'Daily' : hours === 48 ? 'Every 2 days' : hours === 168 ? 'Weekly' : `Every ${hours} hours` }))),
    preference('updates.category', 'Update category', '', 'select', [{ value: '', label: 'Every category' }]),
    preference('updates.skip_unread', 'Skip series with unread chapters', DEFAULT_UPDATE_PREFS.rules.withUnread, 'toggle', undefined, undefined, true),
    preference('updates.skip_not_started', 'Skip series not started', DEFAULT_UPDATE_PREFS.rules.notStarted, 'toggle', undefined, undefined, true),
    preference('updates.skip_completed', 'Skip completed series', DEFAULT_UPDATE_PREFS.rules.completed, 'toggle', undefined, undefined, true),
  ],
  browse: [preference('browse.hideAdultSources', 'Hide adult and mixed sources', false, 'toggle', undefined, undefined, true)],
  downloads: [
    preference(SETTING_QUEUE_CONCURRENCY, 'Comic chapters at once', DEFAULT_QUEUE_CONCURRENCY, 'select', options(COMIC_CONCURRENCY_CHOICES)),
    preference(SETTING_NOVEL_CONCURRENCY, 'Novel chapters at once', DEFAULT_NOVEL_CONCURRENCY, 'select', options(NOVEL_CONCURRENCY_CHOICES)),
    preference(SETTING_MANGA_CONCURRENCY, 'Series at once', DEFAULT_MANGA_CONCURRENCY, 'select', options(Array.from({ length: MAX_MANGA_CONCURRENCY - MIN_MANGA_CONCURRENCY + 1 }, (_, index) => index + MIN_MANGA_CONCURRENCY))),
    preference(SETTING_AUTO_CLEAR_FINISHED, 'Remove finished queue entries', false, 'toggle', undefined, undefined, true),
    preference(SETTING_DELETE_AFTER_READ, 'Delete downloads after reading', false, 'toggle', undefined, undefined, true),
    preference(SETTING_SAVED_CHAPTER_LIMIT, 'Saved chapter limit', 0, 'number', undefined, { min: 0, max: MAX_SAVED_CHAPTER_LIMIT, integer: true }),
  ],
}
function bool(value: string): boolean {
  if (value === 'true' || value === '1' || value === 'on') return true
  if (value === 'false' || value === '0' || value === 'off') return false
  throw new Error('Choose on or off.')
}
function bounded(value: string, label: string, range: { min: number; max: number; integer?: boolean }): number {
  const parsed = value.trim() ? Number(value) : NaN
  if (!Number.isFinite(parsed) || parsed < range.min || parsed > range.max || (range.integer && !Number.isInteger(parsed))) throw new Error(`${label} must be ${range.min}-${range.max}.`)
  return parsed
}
function object(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Saved settings are invalid. Reset this group.')
  return parsed as Record<string, unknown>
}
function readerObject(raw: string | null | undefined): Record<string, unknown> {
  try { return object(raw ?? null) } catch { return {} }
}
export async function preferenceFields(group: 'library' | 'browse' | 'downloads'): Promise<Field[]> {
  const fields = specs[group].map((entry) => ({ ...entry }))
  if (group === 'library') {
    const category = fields.find((entry) => entry.id === 'updates.category')
    if (category) category.options = [{ value: '', label: 'Every category' }, ...(await listCategories()).map((entry) => ({ value: entry.id, label: entry.name }))]
  }
  const stored = await getSettings(fields.map((entry) => entry.id))
  return fields.map((field) => {
    const raw = stored.get(field.id)
    return { id: field.id, label: field.label, kind: field.kind, ...(field.options ? { options: field.options } : {}),
      value: raw === undefined ? field.value : field.flag ? String(raw === '1') : raw,
      ...(field.id === SETTING_SAVED_CHAPTER_LIMIT ? { hint: '0 keeps every saved chapter' } : {}),
      ...(field.id === 'browse.hideAdultSources' ? { hint: 'Browse only, not search or your library' } : {}),
    }
  })
}
export async function adaptFields(): Promise<Field[]> {
  const saved = await readAdaptSettings()
  const custom = saved.mode === 'custom'
  return [
    { id: 'endpoint', label: 'OpenAI-compatible endpoint', kind: 'text', value: saved.endpoint, hint: 'CLIProxy: http://localhost:8317/v1' },
    { id: 'apiKey', label: 'API key', kind: 'password', value: '', hint: saved.apiKey ? 'Saved privately. Leave blank to keep.' : 'Optional, stored only on this device' },
    { id: 'mode', label: 'Generation mode', kind: 'select', value: saved.mode ?? ADAPT_DEFAULTS.mode ?? 'custom', options: options(GENERATION_MODES) },
    ...(['planningModel', 'scriptModel', 'imageModel'] as const).map((id) => ({ id, label: id === 'planningModel' ? 'Planning model' : id === 'scriptModel' ? 'Script model' : 'Image model', kind: 'text' as const, value: saved[id], disabled: !custom })),
    ...([['concurrency', 'Images at once', CONCURRENCY_CHOICES], ['chaptersAtOnce', 'Chapters at once', CHAPTERS_AT_ONCE_CHOICES], ['scriptsAhead', 'Scripts ahead', SCRIPTS_AHEAD_CHOICES], ['readAhead', 'Read ahead', READ_AHEAD_CHOICES]] as const).map(([id, label, choices]) => ({ id, label, kind: 'select' as const, value: String(saved[id] ?? ADAPT_DEFAULTS[id]), options: options([...new Set([...choices, saved[id] ?? ADAPT_DEFAULTS[id] ?? 1])]), disabled: !custom })),
    { id: 'priority', label: 'Priority speed', kind: 'toggle', value: String(saved.priority ?? false), hint: 'Text requests only. Provider charges may differ.' },
  ]
}
export interface NativeReaderPreferences {
  mode: ReaderMode
  fit: PageFit
  continuousStyle: ContinuousStyle
  gap: boolean
  surface: ReaderSurface
  resume: ResumeBehavior
  dimIdle: boolean
  text: TextReaderSettings
  wordStarts: { enabled: boolean; strength: WordStartStrength }
  overridden: boolean
}
const READER_KEYS = ['kagi:reader-mode', 'kagi:reader-fit', 'kagi:reader-continuous-style', 'kagi:reader-page-gap', 'kagi:reader-surface', 'kagi:reader-resume', 'kagi:reader-dim-idle', 'kagi:reader-text', 'kagi:reader-word-starts']
export async function readReaderPreferences(seriesId?: string): Promise<NativeReaderPreferences> {
  const saved = await getSettings(READER_KEYS)
  const text = readerObject(saved.get('kagi:reader-text'))
  const emphasis = readerObject(saved.get('kagi:reader-word-starts'))
  const mode = saved.get('kagi:reader-mode')
  const surface = saved.get('kagi:reader-surface')
  const resume = saved.get('kagi:reader-resume')
  const base: NativeReaderPreferences = {
    mode: mode === 'paged-ltr' || mode === 'paged-rtl' ? mode : 'continuous',
    fit: saved.get('kagi:reader-fit') === 'screen' ? 'screen' : 'width',
    continuousStyle: saved.get('kagi:reader-continuous-style') === 'vertical' ? 'vertical' : 'webtoon',
    gap: saved.get('kagi:reader-page-gap') !== 'off',
    surface: surface === 'muted' || surface === 'black' || surface === 'app' ? surface : 'dark',
    resume: resume === 'notify' || resume === 'restart' ? resume : 'silent',
    dimIdle: saved.get('kagi:reader-dim-idle') === 'on',
    text: {
      fontSize: typeof text.fontSize === 'number' ? Math.min(TEXT_SIZE_RANGE.max, Math.max(TEXT_SIZE_RANGE.min, text.fontSize)) : DEFAULT_TEXT_SETTINGS.fontSize,
      lineHeight: typeof text.lineHeight === 'number' ? Math.min(TEXT_LINE_HEIGHT_RANGE.max, Math.max(TEXT_LINE_HEIGHT_RANGE.min, text.lineHeight)) : DEFAULT_TEXT_SETTINGS.lineHeight,
      width: typeof text.width === 'number' ? Math.min(TEXT_WIDTH_RANGE.max, Math.max(TEXT_WIDTH_RANGE.min, text.width)) : DEFAULT_TEXT_SETTINGS.width,
      font: typeof text.font === 'string' ? text.font : DEFAULT_TEXT_SETTINGS.font,
      justify: typeof text.justify === 'boolean' ? text.justify : DEFAULT_TEXT_SETTINGS.justify,
    },
    wordStarts: { enabled: emphasis.enabled === true, strength: emphasis.strength === 'light' || emphasis.strength === 'strong' ? emphasis.strength : 'medium' },
    overridden: false,
  }
  if (!seriesId) return base
  const override = readerObject(await getSetting(`kagi:reader-series:${seriesId}`))
  if (!Object.keys(override).length) return base
  const parsed = await validateReaderValues(Object.fromEntries(Object.entries(override).map(([key, value]) => [key, String(value)])), base)
  return { ...parsed, overridden: true }
}
export async function readerFields(seriesId?: string): Promise<Field[]> {
  const saved = await readReaderPreferences(seriesId)
  const fonts = await fontCatalogue()
  return [
    { id: 'mode', label: 'Reading mode', kind: 'select', value: saved.mode, options: READER_MODES },
    { id: 'fit', label: 'Page fit', kind: 'select', value: saved.fit, options: PAGE_FITS },
    { id: 'continuousStyle', label: 'Continuous layout', kind: 'select', value: saved.continuousStyle, options: [{ value: 'vertical', label: 'Separate pages' }, { value: 'webtoon', label: 'Webtoon strip' }] },
    { id: 'gap', label: 'Page gaps', kind: 'toggle', value: String(saved.gap) },
    { id: 'surface', label: 'Reader surface', kind: 'select', value: saved.surface, options: READER_SURFACES.map(({ value, label }) => ({ value, label })) },
    { id: 'resume', label: 'Resume behavior', kind: 'select', value: saved.resume, options: RESUME_BEHAVIORS.map(({ value, label }) => ({ value, label })) },
    { id: 'dimIdle', label: `Dim after ${DIM_AFTER_MS / 1000} seconds idle`, kind: 'toggle', value: String(saved.dimIdle) },
    { id: 'font', label: 'Novel font', kind: 'select', value: saved.text.font, options: [{ value: '', label: 'Follow app font' }, ...fonts.map(({ id, name }) => ({ value: id, label: name }))] },
    { id: 'fontSize', label: 'Text size', kind: 'number', value: String(saved.text.fontSize), hint: `${TEXT_SIZE_RANGE.min}-${TEXT_SIZE_RANGE.max} px` },
    { id: 'lineHeight', label: 'Line height', kind: 'number', value: String(saved.text.lineHeight), hint: `${TEXT_LINE_HEIGHT_RANGE.min}-${TEXT_LINE_HEIGHT_RANGE.max}` },
    { id: 'width', label: 'Text measure', kind: 'number', value: String(saved.text.width), hint: `${TEXT_WIDTH_RANGE.min}-${TEXT_WIDTH_RANGE.max} characters` },
    { id: 'justify', label: 'Justify prose', kind: 'toggle', value: String(saved.text.justify) },
    { id: 'wordStarts', label: 'Emphasize word starts', kind: 'toggle', value: String(saved.wordStarts.enabled) },
    { id: 'strength', label: 'Word-start strength', kind: 'select', value: saved.wordStarts.strength, options: WORD_START_STRENGTHS },
  ]
}
async function validateReaderValues(values: Record<string, string>, current: NativeReaderPreferences): Promise<NativeReaderPreferences> {
  const result = { ...current, text: { ...current.text }, wordStarts: { ...current.wordStarts } }
  for (const field of ['mode', 'fit', 'continuousStyle', 'surface', 'resume', 'strength'] as const) {
    const value = values[field]
    if (value === undefined) continue
    if (field === 'mode') { const choice = READER_MODES.find((entry) => entry.value === value); if (!choice) throw new Error('Choose a reading mode.'); result.mode = choice.value }
    if (field === 'fit') { if (value !== 'width' && value !== 'screen') throw new Error('Choose a page fit.'); result.fit = value }
    if (field === 'continuousStyle') { if (value !== 'vertical' && value !== 'webtoon') throw new Error('Choose a continuous layout.'); result.continuousStyle = value }
    if (field === 'surface') { const choice = READER_SURFACES.find((entry) => entry.value === value); if (!choice) throw new Error('Choose a reader surface.'); result.surface = choice.value }
    if (field === 'resume') { const choice = RESUME_BEHAVIORS.find((entry) => entry.value === value); if (!choice) throw new Error('Choose a resume behavior.'); result.resume = choice.value }
    if (field === 'strength') { const choice = WORD_START_STRENGTHS.find((entry) => entry.value === value); if (!choice) throw new Error('Choose a word-start strength.'); result.wordStarts.strength = choice.value }
  }
  for (const field of ['gap', 'dimIdle'] as const) if (values[field] !== undefined) result[field] = bool(values[field])
  if (values.justify !== undefined) result.text.justify = bool(values.justify)
  if (values.wordStarts !== undefined) result.wordStarts.enabled = bool(values.wordStarts)
  if (values.fontSize !== undefined) result.text.fontSize = bounded(values.fontSize, 'Text size', TEXT_SIZE_RANGE)
  if (values.lineHeight !== undefined) result.text.lineHeight = bounded(values.lineHeight, 'Line height', TEXT_LINE_HEIGHT_RANGE)
  if (values.width !== undefined) result.text.width = bounded(values.width, 'Text measure', TEXT_WIDTH_RANGE)
  if (values.font !== undefined) {
    if (values.font && !(await fontCatalogue()).some((font) => font.id === values.font && font.paths.length)) throw new Error('Install that font before selecting it.')
    result.text.font = values.font
  }
  return result
}
async function saveReader(values: Record<string, string>, seriesId?: string): Promise<void> {
  if (seriesId && !await getManga(seriesId)) throw new Error('That series is no longer in your library.')
  const current = await readReaderPreferences(seriesId)
  const saved = await validateReaderValues(values, current)
  if (seriesId) {
    const flattened = { mode: saved.mode, fit: saved.fit, continuousStyle: saved.continuousStyle, gap: saved.gap, surface: saved.surface, resume: saved.resume, dimIdle: saved.dimIdle, ...saved.text, wordStarts: saved.wordStarts.enabled, strength: saved.wordStarts.strength }
    await setSetting(`kagi:reader-series:${seriesId}`, JSON.stringify(flattened))
    return
  }
  await sqliteTransaction(async () => {
    for (const [key, value] of [
      ['kagi:reader-mode', saved.mode], ['kagi:reader-fit', saved.fit], ['kagi:reader-continuous-style', saved.continuousStyle], ['kagi:reader-page-gap', saved.gap ? 'on' : 'off'], ['kagi:reader-surface', saved.surface], ['kagi:reader-resume', saved.resume], ['kagi:reader-dim-idle', saved.dimIdle ? 'on' : 'off'], ['kagi:reader-text', JSON.stringify(saved.text)], ['kagi:reader-word-starts', JSON.stringify(saved.wordStarts)],
    ]) await setSetting(key, value)
  })
}
function normalizePresets(input: unknown, source: ThemePreset['source']): ThemePreset[] {
  if (!Array.isArray(input)) throw new Error('The theme catalogue is invalid.')
  return input.map((value: unknown) => {
    if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' || !('tokens' in value)) throw new Error('The theme catalogue is invalid.')
    const tokens = sanitizeTokens(value.tokens)
    if (!hasAnyToken(tokens)) throw new Error('This theme contains no supported tokens.')
    return { id: value.id, title: 'title' in value && typeof value.title === 'string' ? value.title : value.id, source, tokens }
  })
}
export async function themePresets(): Promise<ThemePreset[]> {
  const [refreshed, custom] = await Promise.all([getPreference('kagi:theme-catalog'), getPreference('kagi:custom-themes')])
  return [DEFAULT_PRESET, ...normalizePresets(refreshed ? JSON.parse(refreshed) : bundledPresets, 'tweakcn'), ...normalizePresets(custom ? JSON.parse(custom) : [], 'custom')]
}
export async function themeTokens(): Promise<Record<string, string>> {
  const [raw, mode, fontId] = await Promise.all([getPreference('kagi:theme-active'), getPreference('kagi:theme'), getPreference('kagi:font')])
  const active = raw ? object(raw) : undefined
  const tokens = active?.tokens ? sanitizeTokens(active.tokens) : DEFAULT_PRESET.tokens
  const light = { ...DEFAULT_PRESET.tokens.theme, ...DEFAULT_PRESET.tokens.light, ...tokens.theme, ...tokens.light }
  const dark = { ...DEFAULT_PRESET.tokens.theme, ...DEFAULT_PRESET.tokens.light, ...DEFAULT_PRESET.tokens.dark, ...tokens.theme, ...tokens.light, ...tokens.dark }
  if (fontId) {
    const font = (await fontCatalogue()).find((entry) => entry.id === fontId)
    if (!font || !font.paths.length) throw new Error('The app font is missing. Install it or choose another font.')
    light['font-sans'] = `'${font.name}', sans-serif`
    dark['font-sans'] = light['font-sans']
  }
  const selectedMode = mode === 'light' || mode === 'system' ? mode : 'dark'
  return { ...(selectedMode === 'light' ? light : dark), mode: selectedMode, ...Object.fromEntries(Object.entries(light).map(([key, value]) => [`light.${key}`, value])), ...Object.fromEntries(Object.entries(dark).map(([key, value]) => [`dark.${key}`, value])) }
}
export async function appearanceFields(): Promise<Field[]> {
  const [mode, font, raw, presets, fonts] = await Promise.all([getPreference('kagi:theme'), getPreference('kagi:font'), getPreference('kagi:theme-active'), themePresets(), fontCatalogue()])
  const active = object(raw)
  return [
    { id: 'mode', label: 'Color mode', kind: 'select', value: mode ?? 'dark', options: options(['system', 'light', 'dark']) },
    { id: 'theme', label: 'Theme preset', kind: 'select', value: typeof active.id === 'string' ? active.id : 'default', options: presets.map(({ id, title }) => ({ value: id, label: title })) },
    { id: 'font', label: 'App font', kind: 'select', value: font ?? '', options: [{ value: '', label: 'Follow theme' }, ...fonts.map(({ id, name }) => ({ value: id, label: name }))] },
  ]
}
export async function profileFields(): Promise<Field[]> {
  const profile = object(await getPreference('kagi:profile'))
  return [
    { id: 'name', label: 'Display name', kind: 'text', value: typeof profile.name === 'string' ? profile.name : '' },
    { id: 'email', label: 'Email', kind: 'text', value: typeof profile.email === 'string' ? profile.email : '', hint: 'Optional, stays on this device' },
    { id: 'accent', label: 'Avatar accent', kind: 'select', value: typeof profile.accent === 'string' ? profile.accent : 'blue', options: ACCENTS.map(({ id, label }) => ({ value: id, label })) },
  ]
}
export interface NativeStorageBucket { id: string; label: string; bytes: number; detail?: string; clearable: boolean; includedInDatabase?: boolean }
async function fileBytes(path: string, excluded?: ReadonlySet<string>): Promise<number> {
  if (excluded?.has(path)) return 0
  let info
  try { info = await lstat(path) } catch (error) { if (isMissing(error)) return 0; throw error }
  if (info.isSymbolicLink()) return 0
  if (info.isFile()) return info.size
  if (!info.isDirectory()) return 0
  let total = 0
  for (const file of await readdir(path)) total += await fileBytes(join(path, file), excluded)
  return total
}
export async function storageBreakdown(): Promise<NativeStorageBucket[]> {
  if (!configuredRoot) throw new Error('Configure settings before reading storage.')
  const [database, offline, novels, comics, fonts, journal, cache, preferences, adaptations] = await Promise.all([
    Promise.all(['', '-wal', '-shm'].map((suffix) => fileBytes(databasePath() + suffix))).then((sizes) => sizes.reduce((sum, size) => sum + size, 0)),
    fileBytes(join(configuredRoot, 'offline')), fileBytes(novelsRoot()), fileBytes(localFilesRoot()), fileBytes(join(configuredRoot, 'fonts')), fileBytes(journalRoot()), fileBytes(imageCacheRoot()), fileBytes(join(configuredRoot, 'private')), adaptationsSize(),
  ])
  const excluded = new Set([databasePath(), `${databasePath()}-wal`, `${databasePath()}-shm`, join(configuredRoot, 'offline'), novelsRoot(), localFilesRoot(), join(configuredRoot, 'fonts'), journalRoot(), imageCacheRoot(), join(configuredRoot, 'private')])
  const other = await fileBytes(configuredRoot, excluded)
  return [
    { id: 'library', label: 'Library database', bytes: database, detail: `${adaptations.count} adaptations included`, clearable: true },
    { id: 'saved-chapters', label: 'Saved chapters', bytes: offline, clearable: true },
    { id: 'imported-books', label: 'Imported books and comics', bytes: novels + comics, clearable: true },
    { id: 'adaptations', label: 'Adaptations', bytes: adaptations.bytes, detail: `${adaptations.count} adaptations, included in library database`, clearable: true, includedInDatabase: true },
    { id: 'fonts', label: 'Custom fonts', bytes: fonts, clearable: false },
    { id: 'journal', label: 'Generation journal', bytes: journal, clearable: true },
    { id: 'cache', label: 'Image cache', bytes: cache, clearable: true },
    { id: 'private', label: 'Private device files', bytes: preferences, clearable: false },
    { id: 'preferences', label: 'Appearance and folder preferences', bytes: 0, detail: 'Included in library database', clearable: true, includedInDatabase: true },
    { id: 'other', label: 'Other app files', bytes: other, clearable: false },
  ]
}
async function removeSeriesData(sourceIds: string[]): Promise<void> {
  const rows = await exec(`SELECT id FROM manga WHERE source_id IN (${sourceIds.map(() => '?').join(',')})`, sourceIds)
  for (const row of rows.rows) {
    const id = String(row[0])
    const chapters = await exec('SELECT id FROM chapters WHERE manga_id = ?', [id])
    for (const chapter of chapters.rows) await unsaveChapter(String(chapter[0]))
    await sqliteTransaction(async () => {
      await exec('DELETE FROM settings WHERE key = ?', [`kagi:reader-series:${id}`])
      await exec('DELETE FROM manga WHERE id = ?', [id])
    })
  }
}
async function clearStorage(bucket: string): Promise<void> {
  await withSettingsMaintenance(async () => {
    if (bucket === 'saved-chapters') await unsaveAllChapters()
    else if (bucket === 'cache') await clearImageCache()
    else if (bucket === 'preferences') {
      await sqliteTransaction(async () => {
        for (const key of ['kagi:theme', 'kagi:theme-active', 'kagi:theme-catalog', 'kagi:custom-themes', 'kagi:font', 'kagi:font-css']) await deletePreference(key)
        await setSetting('kagi:reader-mode', 'continuous')
      })
      await forgetLocalLibrary()
    }
    else if (bucket === 'journal') { for (const run of await journalStore.listRuns()) await journalStore.deleteRun(run.id) }
    else if (bucket === 'imported-books') {
      await removeSeriesData(['local', 'local-novel'])
      await clearBooks()
      await clearImportedComics()
    } else if (bucket === 'adaptations') {
      await removeSeriesData(['adapted'])
      for (const run of await journalStore.listRuns()) if (run.target?.adaptationId) await journalStore.deleteRun(run.id)
      await clearAllAdaptations()
    } else if (bucket === 'library') {
      await unsaveAllChapters()
      await sqliteTransaction(async () => {
        for (const table of ['download_queue', 'history', 'chapter_pages', 'chapter_text', 'chapters', 'manga_category', 'manga', 'categories', 'facts']) await exec(`DELETE FROM ${table}`)
        await exec('DELETE FROM settings WHERE key LIKE ?', ['kagi:reader-series:%'])
      })
    } else throw new Error('Choose a storage group to clear.')
  })
}
async function refreshed(p: Params, notice?: string, extra: Result = {}): Promise<Result> {
  const group = settingsGroup(p)
  return { ...extra, ...(notice ? { notice } : {}), screen: { route: 'settings', routeKey: string(p.routeKey, `settings:${group}`), title: 'Settings', tabs: settingsTabs({ ...p, tab: group }), sections: await settingsSections({ ...p, tab: group }), theme: await themeTokens(), fonts: await installedFontFiles() } }
}
async function saveAdapt(values: Record<string, string>): Promise<void> {
  const before = await readAdaptSettings()
  const mode = GENERATION_MODES.find((entry) => entry === (values.mode ?? before.mode ?? 'custom'))
  if (!mode) throw new Error('Choose a generation mode.')
  const endpoint = (values.endpoint ?? before.endpoint).trim().replace(/\/+$/, '')
  if (endpoint) { const url = new URL(endpoint); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP endpoint without credentials in its URL.') }
  const next: AdaptSettings = { ...before, mode, endpoint, priority: values.priority === undefined ? before.priority : bool(values.priority) }
  const editCustom = mode === 'custom' && (before.mode ?? 'custom') === 'custom'
  if (editCustom) {
    for (const key of ['planningModel', 'scriptModel', 'imageModel'] as const) { const value = (values[key] ?? before[key]).trim(); if (!value) throw new Error('Enter each configured model ID.'); next[key] = value }
    for (const [key, choices] of [['concurrency', CONCURRENCY_CHOICES], ['chaptersAtOnce', CHAPTERS_AT_ONCE_CHOICES], ['scriptsAhead', SCRIPTS_AHEAD_CHOICES], ['readAhead', READ_AHEAD_CHOICES]] as const) if (values[key] !== undefined) {
      const value = bounded(values[key], key, { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true })
      if (!choices.some((choice) => choice === value) && value !== before[key]) throw new Error('Choose an available generation limit.')
      next[key] = value
    }
  }
  const key = values.apiKey || before.apiKey
  await exclusive(async () => {
    try {
      await sqliteTransaction(async () => {
        await writeAdaptSetting('mode', mode)
        await writeAdaptSetting('priority', next.priority)
        if (editCustom) {
          for (const field of ['planningModel', 'scriptModel', 'imageModel'] as const) await writeAdaptSetting(field, next[field])
          for (const field of ['concurrency', 'chaptersAtOnce', 'scriptsAhead', 'readAhead'] as const) await writeAdaptSetting(field, next[field])
        }
        await writeAdaptConnection({ endpoint, apiKey: key })
      })
    } catch (error) {
      try { await writeAdaptConnection({ endpoint: before.endpoint, apiKey: before.apiKey }) }
      catch { throw new Error('Connection changed, but other settings failed. Free disk space and save again.') }
      throw error
    }
  })
}
async function performAction(method: string, p: Params, values: Record<string, string>, selectedPaths: string[]): Promise<Result | undefined> {
  const group = settingsGroup({ ...p, tab: p.tab ?? p.group ?? (method.startsWith('backup.') || method.startsWith('storage.') || method.startsWith('mihon.') ? 'data' : method.startsWith('theme.') || method.startsWith('fonts.') ? 'appearance' : 'adapt') })
  const scope = { ...p, tab: group }
  const selectedPath = () => { if (selectedPaths.length !== 1 || !selectedPaths[0]) throw new Error('Select one file.'); return selectedPaths[0] }
  if (method === 'settings.save') {
    if (group === 'adapt') await saveAdapt(values)
    else if (group === 'reader') await saveReader(values, string(p.seriesId) || undefined)
    else if (group === 'appearance') {
      const current = await appearanceFields()
      const mode = values.mode ?? current.find((field) => field.id === 'mode')?.value ?? 'dark'
      if (!['system', 'light', 'dark'].includes(mode)) throw new Error('Choose a color mode.')
      const font = values.font ?? current.find((field) => field.id === 'font')?.value ?? ''
      if (font && !(await fontCatalogue()).some((entry) => entry.id === font && entry.paths.length)) throw new Error('Install that font before selecting it.')
      const themeId = values.theme ?? current.find((field) => field.id === 'theme')?.value ?? 'default'
      const preset = (await themePresets()).find((entry) => entry.id === themeId)
      if (!preset) throw new Error('Select an available theme.')
      await setPreferences({ 'kagi:theme': mode, 'kagi:font': font, 'kagi:theme-active': JSON.stringify(preset) })
    } else if (group === 'library' || group === 'browse' || group === 'downloads') {
      const fields = await preferenceFields(group)
      const updates: Record<string, string> = {}
      for (const field of specs[group]) {
        const value = values[field.id]
        if (value === undefined) continue
        const choices = fields.find((entry) => entry.id === field.id)?.options
        if (choices && !choices.some((entry) => entry.value === value)) throw new Error(`Choose a valid ${field.label.toLowerCase()}.`)
        if (field.range) bounded(value, field.label, field.range)
        updates[field.id] = field.flag ? bool(value) ? '1' : '0' : value
      }
      await sqliteTransaction(async () => { for (const [key, value] of Object.entries(updates)) { if (key === SETTING_SAVED_CHAPTER_LIMIT) await setSavedChapterLimit(Number(value)); else await setSetting(key, value) } })
      if (group === 'downloads') {
        if (updates[SETTING_QUEUE_CONCURRENCY]) queueManager.setConcurrency(Number(updates[SETTING_QUEUE_CONCURRENCY]))
        if (updates[SETTING_NOVEL_CONCURRENCY]) queueManager.setNovelConcurrency(Number(updates[SETTING_NOVEL_CONCURRENCY]))
        if (updates[SETTING_MANGA_CONCURRENCY]) queueManager.setMangaConcurrency(Number(updates[SETTING_MANGA_CONCURRENCY]))
        if (updates[SETTING_AUTO_CLEAR_FINISHED] !== undefined) queueManager.setAutoClearFinished(updates[SETTING_AUTO_CLEAR_FINISHED] === '1')
      }
    } else throw new Error('Use the data actions to manage backups and storage.')
    return refreshed(scope, 'Settings saved.')
  }
  if (method === 'settings.adapt.test' || method === 'settings.adapt.models') {
    const saved = await readAdaptSettings()
    const endpoint = (values.endpoint ?? saved.endpoint).trim().replace(/\/+$/, '')
    if (!endpoint) throw new Error('Enter an endpoint before testing the connection.')
    const url = new URL(endpoint)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP endpoint without credentials in its URL.')
    let models: string[]
    try { models = await listModels({ endpoint, apiKey: values.apiKey || saved.apiKey }) } catch { throw new Error('Connection failed. Check the endpoint and API key, then try again.') }
    const configured = [values.planningModel ?? saved.planningModel, values.scriptModel ?? saved.scriptModel, values.imageModel ?? saved.imageModel]
    const result = await refreshed({ ...scope, tab: 'adapt' }, `Connection returned ${models.length} models.`)
    if (result.screen) {
      for (const section of result.screen.sections) for (const field of section.fields ?? []) if (values[field.id] !== undefined) field.value = values[field.id]
      const missing = configured.filter((id) => !models.includes(id))
      result.screen.sections.push({ id: 'adapt-models', title: 'Available models', status: 'ready', layout: 'list', rows: [
        ...missing.map((id) => ({ id: `missing:${id}`, title: id, detail: 'Configured model not listed. Your selection is unchanged.' })),
        ...models.map((id) => ({ id, title: id })),
      ], empty: 'The endpoint returned no models.' })
    }
    return result
  }
  if (method === 'settings.adapt.clear-key') { await writeAdaptSetting('apiKey', ''); return refreshed(scope, 'API key removed.') }
  if (method === 'settings.adapt.reset-connection') { await writeAdaptConnection({ endpoint: '', apiKey: '' }); return refreshed(scope, 'Generation connection reset.') }
  if (method === 'settings.reader.reset') {
    const seriesId = string(p.seriesId)
    if (seriesId) await setSetting(`kagi:reader-series:${seriesId}`, '{}')
    else await saveReader({ fontSize: String(DEFAULT_TEXT_SETTINGS.fontSize), lineHeight: String(DEFAULT_TEXT_SETTINGS.lineHeight), width: String(DEFAULT_TEXT_SETTINGS.width), font: DEFAULT_TEXT_SETTINGS.font, justify: String(DEFAULT_TEXT_SETTINGS.justify) })
    return refreshed({ ...scope, tab: 'reader' }, seriesId ? 'Series now follows global settings.' : 'Novel typography reset.')
  }
  if (method === 'settings.reader.open') return { navigate: { route: 'settings', params: { tab: 'reader', seriesId: values.seriesId ?? string(p.seriesId) } } }
  if (method === 'settings.reader.search') return { navigate: { route: 'settings', params: { tab: 'reader', readerSearch: values.search ?? '', readerPage: 0 } } }
  if (method === 'settings.incognito') {
    setIncognito(bool(values.enabled ?? string(p.enabled)))
    return refreshed({ ...scope, tab: 'library' })
  }
  if (method === 'settings.profile.save') {
    const old = object(await getPreference('kagi:profile'))
    const name = (values.name ?? '').trim()
    const email = (values.email ?? '').trim()
    if (!name || name.length > 80) throw new Error('Enter a display name of 1-80 characters.')
    if (email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error('Enter a valid email or leave it blank.')
    const accent = values.accent ?? 'blue'
    if (!ACCENTS.some((entry) => entry.id === accent)) throw new Error('Choose an avatar accent.')
    await setPreference('kagi:profile', JSON.stringify({ name, email, accent, createdAt: typeof old.createdAt === 'number' ? old.createdAt : Date.now() }))
    return refreshed({ ...scope, tab: 'library' }, 'Local profile saved.')
  }
  if (method === 'settings.profile.clear') { await deletePreference('kagi:profile'); return refreshed({ ...scope, tab: 'library' }, 'Local profile removed.') }
  if (method === 'theme.select') {
    const preset = (await themePresets()).find((entry) => entry.id === string(p.id, values.theme))
    if (!preset) throw new Error('Choose an available theme.')
    await setPreference('kagi:theme-active', JSON.stringify(preset))
    return refreshed(scope)
  }
  if (method === 'theme.mode') {
    const mode = values.mode ?? string(p.mode)
    if (!['light', 'dark', 'system'].includes(mode)) throw new Error('Choose a color mode.')
    await setPreference('kagi:theme', mode)
    return refreshed(scope)
  }
  if (method === 'theme.import') {
    const text = selectedPaths.length ? new TextDecoder().decode(await readBytes(selectedPath())) : values.css ?? ''
    const tokens = parseTheme(text)
    if (!tokens) throw new Error('Choose theme CSS or a shadcn registry JSON file.')
    const title = (values.title ?? 'Imported theme').trim()
    if (!title || title.length > 80) throw new Error('Enter a theme name of 1-80 characters.')
    const all = await themePresets()
    const preset: ThemePreset = { id: `custom:${slugify(title, new Set(all.map((entry) => entry.id.replace(/^custom:/, ''))))}`, title, source: 'custom', tokens }
    await setPreferences({ 'kagi:custom-themes': JSON.stringify([...all.filter((entry) => entry.source === 'custom'), preset]), 'kagi:theme-active': JSON.stringify(preset) })
    return refreshed(scope, 'Theme imported.')
  }
  if (method === 'theme.export') {
    const active = object(await getPreference('kagi:theme-active'))
    const preset = (await themePresets()).find((entry) => entry.id === (typeof active.id === 'string' ? active.id : 'default'))
    if (!preset) throw new Error('Select a theme before exporting.')
    const path = await settingsExportDestination(selectedPath())
    await atomicExport(path, string(p.format) === 'css' ? tokensToCss(preset.tokens) : JSON.stringify(tokensToRegistryItem(preset.title, preset.tokens), null, 2))
    return { exportPath: path, notice: 'Theme exported.' }
  }
  if (method === 'theme.remove') {
    const id = string(p.id, values.theme)
    const all = await themePresets()
    if (!all.some((entry) => entry.id === id && entry.source === 'custom')) throw new Error('Only imported themes can be removed.')
    const active = object(await getPreference('kagi:theme-active'))
    await setPreferences({ 'kagi:custom-themes': JSON.stringify(all.filter((entry) => entry.source === 'custom' && entry.id !== id)), ...(active.id === id ? { 'kagi:theme-active': JSON.stringify(DEFAULT_PRESET) } : {}) })
    return refreshed(scope, 'Theme removed.')
  }
  if (method === 'theme.refresh') {
    const response = await fetch('https://tweakcn.com/r/themes/registry.json', { signal: AbortSignal.timeout(30_000), cache: 'no-store' })
    if (!response.ok) throw new Error('Theme refresh failed. Try again later.')
    const registry: unknown = await response.json()
    if (!registry || typeof registry !== 'object' || !('items' in registry) || !Array.isArray(registry.items)) throw new Error('The theme registry returned invalid data.')
    const presets: ThemePreset[] = registry.items.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || !('name' in entry) || typeof entry.name !== 'string' || !('cssVars' in entry)) return []
      const tokens = sanitizeTokens(entry.cssVars)
      if (!hasAnyToken(tokens)) return []
      return [{ id: entry.name, title: 'title' in entry && typeof entry.title === 'string' ? entry.title : entry.name, source: 'tweakcn' as const, tokens }]
    })
    if (!presets.length) throw new Error('The theme registry returned no valid themes.')
    await setPreference('kagi:theme-catalog', JSON.stringify(presets))
    return refreshed(scope, `${presets.length} themes refreshed.`)
  }
  if (method === 'fonts.install') { const font = await installGoogleFont(values.name ?? string(p.name)); return refreshed(scope, `${font.name} installed.`) }
  if (method === 'fonts.select') {
    const id = string(p.id, values.font)
    if (id && !(await fontCatalogue()).some((font) => font.id === id && font.paths.length)) throw new Error('Install that font before selecting it.')
    await setPreference('kagi:font', id)
    return refreshed(scope)
  }
  if (method === 'fonts.remove') {
    const id = string(p.id)
    const text = object(await getSetting('kagi:reader-text'))
    if (await getPreference('kagi:font') === id || text.font === id) throw new Error('Choose another app and reader font before removing this one.')
    const overrides = await exec('SELECT value FROM settings WHERE key LIKE ?', ['kagi:reader-series:%'])
    if (overrides.rows.some((row) => object(String(row[0])).font === id)) throw new Error('Remove this font from series overrides before deleting it.')
    const catalogue = await fontCatalogue()
    const removed = catalogue.find((font) => font.id === id)
    if (removed && !catalogue.some((font) => font.id !== id && font.name === removed.name && font.paths.length)) {
      const tokens = await themeTokens()
      if (Object.entries(tokens).some(([key, value]) => /(?:^|\.)(?:font-sans|font-serif|font-mono)$/.test(key) && value.split(',').some((family) => family.trim().replace(/^['"]|['"]$/g, '') === removed.name))) throw new Error('Choose another theme before removing its font.')
    }
    await removeGoogleFont(id)
    return refreshed(scope, 'Custom font removed.')
  }
  if (method === 'fonts.clear-cache') { await clearFontCache(); return refreshed(scope, 'Unused font cache cleared.') }
  if (method === 'backup.export') return { exportPath: await exportLibraryBackup(selectedPath()), notice: 'Library backup exported.' }
  if (method === 'backup.restore') { await restoreLibraryBackup(selectedPath()); return refreshed({ ...scope, tab: 'data' }, 'Library restored.') }
  if (method === 'mihon.review') {
    await reviewMihonBackup(selectedPath())
    return refreshed({ ...scope, tab: 'data' })
  }
  if (method === 'mihon.commit') {
    const result = await commitMihonImport(string(p.reviewId))
    return refreshed({ ...scope, tab: 'data' }, `${result.seriesAdded} series added, ${result.seriesMerged} merged, ${result.chaptersAdvanced} chapters advanced.`)
  }
  if (method === 'mihon.cancel') { cancelMihonImport(string(p.reviewId)); return refreshed({ ...scope, tab: 'data' }) }
  if (method === 'storage.refresh') return refreshed({ ...scope, tab: 'data' })
  if (method === 'storage.clear') { await clearStorage(string(p.bucket)); return refreshed(scope, 'Storage cleared.') }
  if (method === 'storage.unsave') { await withSettingsMaintenance(() => unsaveChapter(string(p.chapterId))); return refreshed({ ...scope, tab: 'downloads' }, 'Saved chapter removed.') }
  if (method === 'storage.unsave-read' || method === 'storage.unsave-series') {
    const seriesId = string(p.seriesId)
    if (method === 'storage.unsave-series' && !seriesId) throw new Error('Choose a series to remove its downloads.')
    await withSettingsMaintenance(async () => {
      for (const chapter of await listSavedChapters()) if (method === 'storage.unsave-read' ? chapter.read : chapter.mangaId === seriesId) await unsaveChapter(chapter.chapterId)
    })
    return refreshed({ ...scope, tab: 'downloads' }, 'Saved chapters removed.')
  }
  if (/^(settings|theme|fonts|backup|storage|mihon)\./.test(method)) throw new Error('Unknown settings action.')
  return undefined
}
export function settingsAction(method: string, p: Params, values: Record<string, string>, selectedPaths: string[]): Promise<Result | undefined> {
  if (!/^(settings|theme|fonts|backup|storage|mihon)\./.test(method)) return Promise.resolve(undefined)
  const result = actionChain.then(() => performAction(method, p, values, selectedPaths))
  actionChain = result.then(() => undefined, () => undefined)
  return result
}
