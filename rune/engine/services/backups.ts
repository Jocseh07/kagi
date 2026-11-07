import { Database } from 'bun:sqlite'
import { dirname, relative, resolve, join } from 'node:path'
import { rm, realpath } from 'node:fs/promises'
import { planMihonImport } from '../../../src/lib/backup/mihon-plan'
import type { MihonImportPlan } from '../../../src/lib/backup/mihon-plan'
import { runMihonImport } from '../../../src/lib/backup/mihon-import'
import type { MihonImportResult } from '../../../src/lib/backup/mihon-import'
import { exportDatabase, importDatabase, exclusive, databasePath, exec, sqliteTransaction } from '../adapters/database'
import { readBytes } from '../adapters/storage'
import type { Section } from '../protocol'
import { atomicExport } from './files'
import { getPreferences, setPreferences } from '../adapters/preferences'
import { getSource } from '../../../src/lib/sources/registry'

export interface SettingsMaintenance {
  withStoppedJobs<T>(operation: () => Promise<T>): Promise<T>
  initializeRestoredDatabase(): Promise<void>
}
let maintenance: SettingsMaintenance | undefined
let review: { id: string; plan: MihonImportPlan } | undefined
const REQUIRED_TABLES = ['manga', 'chapters', 'categories', 'manga_category', 'history', 'settings']
export function configureBackupMaintenance(value: SettingsMaintenance): void { maintenance = value }
export function withSettingsMaintenance<T>(operation: () => Promise<T>): Promise<T> {
  if (!maintenance) throw new Error('The native maintenance controller is not configured.')
  return maintenance.withStoppedJobs(operation)
}
function validatedDatabase(bytes: Uint8Array): Database {
  if (new TextDecoder().decode(bytes.subarray(0, 16)) !== 'SQLite format 3\0') throw new Error('Choose a valid Kagi SQLite backup.')
  let candidate: Database
  try { candidate = Database.deserialize(bytes) } catch { throw new Error('The backup is not a readable SQLite database.') }
  try {
    if (candidate.query('PRAGMA integrity_check').values().some((row) => row[0] !== 'ok')) throw new Error('The backup failed its integrity check.')
    const tables = new Set(candidate.query("SELECT name FROM sqlite_schema WHERE type = 'table'").values().map((row) => String(row[0])))
    if (REQUIRED_TABLES.some((table) => !tables.has(table))) throw new Error('This SQLite file is not a Kagi library backup.')
    if (candidate.query('PRAGMA foreign_key_check').values().length) throw new Error('The backup contains broken library references.')
    const triggers = candidate.query("SELECT name FROM sqlite_schema WHERE type = 'trigger'").values()
    if (triggers.length) throw new Error('Backups containing database triggers cannot be restored.')
    candidate.query('SELECT id, source_id, url, title FROM manga LIMIT 0').all()
    candidate.query('SELECT id, manga_id, url, read, last_page_read FROM chapters LIMIT 0').all()
    candidate.query('SELECT key, value FROM settings LIMIT 0').all()
    return candidate
  } catch (error) { candidate.close(); throw error }
}
function scrubPrivateData(database: Database): void {
  database.exec('PRAGMA secure_delete = ON')
  const tables = new Set(database.query("SELECT name FROM sqlite_schema WHERE type = 'table'").values().map((row) => String(row[0])))
  const sensitive = /(?:api.?key|password|secret|token|credential|^sync[.:]|^auth[.:]|^clerk[.:]|^polar[.:]|^kagi:profile$|^kagi:font(?:$|-css$)|^profile[.:]|^adapt\.endpoint$|^native\.fonts$|^local\.|^journal\.directory$)/i
  for (const [table, column] of [['settings', 'key'], ['native_preferences', 'id'], ['facts', 'key']] as const) {
    if (!tables.has(table)) continue
    const remove = database.prepare(`DELETE FROM "${table}" WHERE "${column}" = ?`)
    try {
      for (const row of database.query(`SELECT DISTINCT "${column}" FROM "${table}"`).values()) if (sensitive.test(String(row[0]))) remove.run(String(row[0]))
    } finally { remove.finalize() }
  }
  if (tables.has('source_prefs')) database.exec('DELETE FROM source_prefs')
  database.exec('VACUUM')
}
export async function settingsExportDestination(path: string): Promise<string> {
  if (!path) throw new Error('Choose where to save the export.')
  const destination = resolve(path)
  const [parent, root] = await Promise.all([realpath(dirname(destination)), realpath(dirname(databasePath()))])
  const withinData = relative(root, parent)
  if (withinData === '' || (!withinData.startsWith('../') && withinData !== '..')) throw new Error('Save exports outside the app data directory.')
  return destination
}
export async function exportLibraryBackup(path: string): Promise<string> {
  if (!path) throw new Error('Choose where to save the backup.')
  return withSettingsMaintenance(() => exclusive(async () => {
    const copy = validatedDatabase(await exportDatabase())
    try {
      scrubPrivateData(copy)
      const destination = await settingsExportDestination(path)
      await atomicExport(destination, copy.serialize())
      return destination
    } finally { copy.close() }
  }))
}
export async function restoreLibraryBackup(path: string): Promise<void> {
  if (!maintenance) throw new Error('The native maintenance controller is not configured.')
  const lifecycle = maintenance
  const candidate = validatedDatabase(await readBytes(path))
  let bytes: Uint8Array
  try { scrubPrivateData(candidate); bytes = candidate.serialize() } finally { candidate.close() }
  await withSettingsMaintenance(() => exclusive(async () => {
    const previous = await exportDatabase()
    const localPreferences = Object.fromEntries(Object.entries(await getPreferences()).filter(([key]) => /^(?:kagi:profile$|kagi:font(?:$|-css$)|native\.fonts$|local\.|journal\.directory$)/.test(key)))
    const sourcePreferences = await exec('SELECT id, updated_at, device_id, source_id, key, value FROM source_prefs')
    const recovery = join(dirname(databasePath()), 'restore-recovery.sqlite')
    await atomicExport(recovery, previous)
    try {
      await importDatabase(bytes)
      await lifecycle.initializeRestoredDatabase()
      await setPreferences(localPreferences)
      await sqliteTransaction(async () => {
        for (const row of sourcePreferences.rows) await exec('INSERT OR REPLACE INTO source_prefs(id,updated_at,device_id,source_id,key,value) VALUES (?,?,?,?,?,?)', row)
      })
      await rm(recovery, { force: true })
    } catch (cause) {
      try { await importDatabase(previous); await lifecycle.initializeRestoredDatabase() }
      catch { throw new Error('Restore failed. Restart Kagi using restore-recovery.sqlite from the app data directory.') }
      await rm(recovery, { force: true })
      throw new Error('Restore failed. Your previous library has been restored.', { cause })
    }
  }))
}
export async function reviewMihonBackup(path: string): Promise<Section[]> {
  const plan = await planMihonImport(await readBytes(path))
  review = { id: crypto.randomUUID(), plan }
  return mihonReviewSections()
}
export function mihonReviewSections(): Section[] {
  if (!review) return []
  const { id, plan } = review
  return [
    { id: 'mihon-review', title: 'Review Mihon import', status: 'ready', layout: 'list', rows: [
      { id: 'mihon-total', title: `${plan.entries.length} of ${plan.totalSeries} series matched`, subtitle: `${plan.totalChapters} chapters in backup`, detail: `${plan.categories.length} categories` },
      ...plan.sources.map((source) => {
        const rating = getSource(source.sourceId).contentRating
        return { id: `mihon-source:${source.sourceId}`, title: source.sourceName, subtitle: `${source.series} series, ${source.chapters} chapters`, detail: `${source.readChapters} read, ${source.favorites} favorites, ${source.skippedChapters} unsupported chapters`, badges: rating === 'safe' ? [] : [rating === 'mixed' ? 'Mixed' : 'Adult'] }
      }),
    ], actions: [
      ...(plan.entries.length ? [{ id: 'mihon-commit', label: 'Merge library', method: 'mihon.commit', params: { reviewId: id }, confirm: 'Merge matched series, categories, and progress? Existing progress never moves backward.' }] : []),
      { id: 'mihon-cancel', label: 'Cancel import', method: 'mihon.cancel', params: { reviewId: id } },
    ] },
    { id: 'mihon-unsupported', title: 'Not imported', status: 'ready', layout: 'list', empty: 'Every series matches a supported source.', rows: plan.skipped.map((series, index) => ({
      id: `mihon-skip:${index}`, title: series.title, subtitle: series.sourceName, detail: `${series.chapters} chapters, ${series.readChapters} read. ${series.reason === 'unsupported-source' ? 'Source not supported' : 'Series URL not recognized'}`,
    })) },
  ]
}
export async function commitMihonImport(id: string): Promise<MihonImportResult> {
  if (!review || review.id !== id) throw new Error('This import review is no longer open. Select the backup again.')
  const current = review
  return withSettingsMaintenance(async () => {
    const result = await sqliteTransaction(() => runMihonImport(current.plan))
    if (review === current) review = undefined
    return result
  })
}
export function cancelMihonImport(id: string): void {
  if (!review || review.id !== id) throw new Error('This import review is no longer open.')
  review = undefined
}
