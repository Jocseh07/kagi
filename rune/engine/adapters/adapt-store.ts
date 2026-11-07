import { exec, sqliteTransaction } from './database'
import type { Adaptation, Character, MangaChapter, Prop, Place, PanelCheck, GenerationState, GenerationApplication } from '../../../src/lib/adapt/store'
import { chapterId, panelKey, generationStateIdentity } from '../../../src/lib/adapt/keys'
export type * from '../../../src/lib/adapt/store'
export function nativeSchema(): string[] {
  return [
    'CREATE TABLE IF NOT EXISTS native_adaptations (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS native_characters (id TEXT PRIMARY KEY, adaptation_id TEXT NOT NULL, data TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS native_characters_owner ON native_characters(adaptation_id)',
    'CREATE TABLE IF NOT EXISTS native_chapters (id TEXT PRIMARY KEY, adaptation_id TEXT NOT NULL, data TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS native_chapters_owner ON native_chapters(adaptation_id)',
    'CREATE TABLE IF NOT EXISTS native_blobs (id TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes BLOB NOT NULL)',
    'CREATE TABLE IF NOT EXISTS native_texts (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS native_novels (id TEXT PRIMARY KEY, data TEXT NOT NULL, path TEXT NOT NULL)',
  ]
}
type Table = 'adaptations' | 'characters' | 'chapters' | 'texts'
async function get<T>(table: Table, id: string): Promise<T | undefined> {
  const row = (await exec(`SELECT data FROM native_${table} WHERE id = ?`, [id])).rows[0]
  return row ? JSON.parse(String(row[0])) as T : undefined
}
async function put(table: Table, id: string, data: unknown, owner?: string): Promise<void> {
  if (owner !== undefined) await exec(`INSERT INTO native_${table}(id, adaptation_id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET adaptation_id=excluded.adaptation_id, data=excluded.data`, [id, owner, JSON.stringify(data)])
  else await exec(`INSERT INTO native_${table}(id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`, [id, JSON.stringify(data)])
}
async function all<T>(table: Table, owner?: string): Promise<T[]> {
  const result = await exec(`SELECT data FROM native_${table}${owner === undefined ? '' : ' WHERE adaptation_id = ?'} ORDER BY id`, owner === undefined ? [] : [owner])
  return result.rows.map((row) => JSON.parse(String(row[0])) as T)
}
async function remove(table: Table, id: string): Promise<void> { await exec(`DELETE FROM native_${table} WHERE id = ?`, [id]) }
let version = 0
const listeners = new Set<() => void>()
const blobListeners = new Map<string, Set<() => void>>()
function changed(): void { version++; for (const listener of listeners) listener() }
function blobChanged(key: string): void { for (const listener of blobListeners.get(key) ?? []) listener() }
export function supportsAdaptations(): boolean { return true }
export function subscribeAdaptStore(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }
export function getAdaptStoreVersion(): number { return version }
export function subscribeBlob(key: string, listener: () => void): () => void {
  const set = blobListeners.get(key) ?? new Set(); set.add(listener); blobListeners.set(key, set)
  return () => { set.delete(listener); if (!set.size) blobListeners.delete(key) }
}
export async function listAdaptations(): Promise<Adaptation[]> { return (await all<Adaptation>('adaptations')).sort((a,b) => a.createdAt-b.createdAt) }
export function getAdaptation(id: string): Promise<Adaptation | undefined> { return get('adaptations', id) }
export async function findAdaptationByNovel(sourceId: string, novelUrl: string): Promise<Adaptation | undefined> { return (await listAdaptations()).find((row) => row.sourceId === sourceId && row.novelUrl === novelUrl) }
export async function putAdaptation(row: Adaptation): Promise<void> { await put('adaptations', row.id, row); changed() }
async function edit<T>(table: Table, id: string, update: (row: T) => T, owner?: string): Promise<T | undefined> {
  const next = await sqliteTransaction(async () => { const row = await get<T>(table,id); if (!row) return undefined; const next = update(row); await put(table,id,next,owner); return next })
  if (next) changed()
  return next
}
export function updateAdaptation(id: string, patch: Partial<Omit<Adaptation,'id'>>): Promise<Adaptation | undefined> { return edit<Adaptation>('adaptations',id,(row) => ({...row,...patch})) }
export async function deleteAdaptation(id: string): Promise<void> {
  const removed = await sqliteTransaction(async () => {
    const removed = await keys(`${id}/`)
    await remove('adaptations',id)
    for (const table of ['characters','chapters']) await exec(`DELETE FROM native_${table} WHERE adaptation_id = ?`,[id])
    await exec('DELETE FROM native_blobs WHERE substr(id,1,?) = ?', [id.length+1, `${id}/`])
    await exec('DELETE FROM native_texts WHERE substr(id,1,?) = ?', [id.length+1, `${id}/`])
    return removed
  })
  for (const key of removed) blobChanged(key)
  changed()
}
export async function listCharacters(id: string): Promise<Character[]> { return (await all<Character>('characters',id)).sort((a,b) => a.firstNovelChapter-b.firstNovelChapter || a.name.localeCompare(b.name)) }
export async function putCharacter(row: Character): Promise<void> { await put('characters',row.id,row,row.adaptationId); changed() }
export async function setSheetKey(id: string, lookId: string, key: string): Promise<void> {
  const written = await sqliteTransaction(async () => {
    const row = await get<Character>('characters',id); if (!row) return false
    row.looks = row.looks.map((look) => look.id === lookId ? {...look,sheetKey:key} : look)
    await put('characters',id,row,row.adaptationId); return true
  })
  if (written) changed()
}
export async function patchProp(id: string, propId: string, patch: Partial<Omit<Prop,'id'>>): Promise<void> { await edit<Adaptation>('adaptations',id,(row) => ({...row,props:(row.props ?? []).map((p) => p.id === propId ? {...p,...patch} : p)})) }
export async function addProps(id: string, added: readonly Prop[]): Promise<void> { await edit<Adaptation>('adaptations',id,(row) => ({...row,props:[...row.props ?? [],...added.filter((p) => !row.props?.some((old) => old.id === p.id))]})) }
export async function patchPlace(id: string, placeId: string, patch: Partial<Omit<Place,'id'>>): Promise<void> { await edit<Adaptation>('adaptations',id,(row) => ({...row,places:(row.places ?? []).map((p) => p.id === placeId ? {...p,...patch} : p)})) }
export async function addPlaces(id: string, added: readonly Place[]): Promise<void> { await edit<Adaptation>('adaptations',id,(row) => ({...row,places:[...row.places ?? [],...added.filter((p) => !row.places?.some((old) => old.id === p.id))]})) }
export async function listChapters(id: string): Promise<MangaChapter[]> { return (await all<MangaChapter>('chapters',id)).sort((a,b) => a.number-b.number) }
export function getChapter(id: string, number: number): Promise<MangaChapter | undefined> { return get('chapters',chapterId(id,number)) }
export async function putChapter(row: MangaChapter): Promise<void> { await put('chapters',row.id,row,row.adaptationId); changed() }
export function updateChapter(id: string, number: number, patch: Partial<Omit<MangaChapter,'id'>>): Promise<MangaChapter | undefined> { return edit<MangaChapter>('chapters',chapterId(id,number),(row) => ({...row,...patch}),patch.adaptationId ?? id) }
export async function patchPanelChecks(id: string, number: number, checks: ReadonlyMap<string,PanelCheck | undefined>): Promise<void> {
  if (!checks.size) return
  const written = await sqliteTransaction(async () => {
    const row = await getChapter(id,number); if (!row?.script) return false
    row.script = row.script.map((page,p) => ({...page,panels:page.panels.map((panel,i) => checks.has(`${p+1}-${i+1}`) ? {...panel,check:checks.get(`${p+1}-${i+1}`)} : panel)}))
    await put('chapters',row.id,row,row.adaptationId); return true
  })
  if (written) changed()
}
export async function getBlob(key: string): Promise<Blob | undefined> {
  const row = (await exec('SELECT mime, bytes FROM native_blobs WHERE id = ?', [key])).rows[0]
  return row ? new Blob([row[1] as Uint8Array<ArrayBuffer>],{type:String(row[0])}) : undefined
}
async function writeBlob(key: string, blob: Blob | undefined, bytes?: Uint8Array): Promise<void> {
  const previous = Number((await exec('SELECT length(bytes) FROM native_blobs WHERE id = ?',[key])).rows[0]?.[0] ?? 0)
  if (blob) await exec('INSERT INTO native_blobs(id,mime,bytes) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET mime=excluded.mime, bytes=excluded.bytes',[key,blob.type,bytes ?? new Uint8Array(await blob.arrayBuffer())])
  else await exec('DELETE FROM native_blobs WHERE id = ?',[key])
  const id = key.slice(0,key.indexOf('/')); const row = await getAdaptation(id)
  if (row) {
    const total = row.bytes === undefined
      ? Number((await exec('SELECT coalesce(sum(length(bytes)),0) FROM native_blobs WHERE substr(id,1,?) = ?', [id.length+1,`${id}/`])).rows[0]?.[0] ?? 0)
      : Math.max(0,row.bytes-previous+(blob?.size ?? 0))
    await put('adaptations',id,{...row,bytes:total,blobVersions:{...row.blobVersions,[key]:crypto.randomUUID()}})
  }
}
export async function putBlob(key: string, blob: Blob): Promise<void> { const bytes = new Uint8Array(await blob.arrayBuffer()); await sqliteTransaction(() => writeBlob(key,blob,bytes)); blobChanged(key) }
export async function deleteBlob(key: string): Promise<void> { await sqliteTransaction(() => writeBlob(key,undefined)); blobChanged(key) }
export async function putPanelImage(id: string, number: number, page: number, panel: number, image: Blob, check: PanelCheck): Promise<void> {
  const key = panelKey(id,number,page,panel); const bytes = new Uint8Array(await image.arrayBuffer())
  await sqliteTransaction(async () => { await writeBlob(key,image,bytes); const row = await getChapter(id,number); const target = row?.script?.[page-1]?.panels[panel-1]; if (row && target) { target.check = check; await put('chapters',row.id,row,id) } }); blobChanged(key); changed()
}
async function keys(prefix: string): Promise<string[]> { return (await exec('SELECT id FROM native_blobs WHERE substr(id,1,?) = ? ORDER BY id',[prefix.length,prefix])).rows.map((r) => String(r[0])) }
export async function listPanelKeys(id: string, number: number): Promise<string[]> { const prefix = `${id}/panel/${number}/`; return (await keys(prefix)).map((k) => k.slice(prefix.length)) }
export async function listPageKeys(id: string, number: number): Promise<number[]> { const prefix = `${id}/page/${number}/`; return (await keys(prefix)).map((k) => Number(k.slice(prefix.length))) }
export async function deleteBlobsWithPrefix(prefix: string): Promise<void> {
  const found = await sqliteTransaction(async () => { const found = await keys(prefix); for (const key of found) await writeBlob(key,undefined); return found })
  for (const key of found) blobChanged(key)
}
export function getText(key: string): Promise<string | undefined> { return get('texts',key) }
export async function putText(key: string, text: string): Promise<void> { await put('texts',key,text) }
export async function deleteTexts(keys: readonly string[]): Promise<void> { await sqliteTransaction(async () => { for (const key of keys) await remove('texts',key) }) }
export function adaptationsSize(): Promise<{bytes:number;count:number}> {
  return sqliteTransaction(async () => { const rows = await listAdaptations(); const result = await exec('SELECT coalesce(sum(length(bytes)),0) FROM native_blobs'); return {bytes:Number(result.rows[0]?.[0] ?? 0),count:rows.length} })
}
export async function clearAllAdaptations(): Promise<void> {
  const found = await sqliteTransaction(async () => { const found = await keys(''); for (const table of ['adaptations','characters','chapters','blobs','texts']) await exec(`DELETE FROM native_${table}`); return found })
  for (const key of found) blobChanged(key)
  changed()
}
async function state(id: string, includeBlobs: boolean): Promise<GenerationState> {
  const adaptation = await getAdaptation(id); if (!adaptation) throw new Error('The adaptation no longer exists.')
  const prefix = `${id}/`; const blobs = new Map<string,Blob>()
  if (includeBlobs) for (const key of await keys(prefix)) blobs.set(key,(await getBlob(key))!)
  const texts = new Map((await exec('SELECT id,data FROM native_texts WHERE substr(id,1,?) = ? ORDER BY id',[prefix.length,prefix])).rows.map((row) => [String(row[0]),JSON.parse(String(row[1])) as string]))
  return {adaptation,chapters:await listChapters(id),characters:await listCharacters(id),blobs,texts}
}
export function readGenerationState(id: string, includeBlobs = true): Promise<GenerationState> { return sqliteTransaction(() => state(id,includeBlobs)) }
export async function commitGenerationState(before: GenerationState, next: GenerationState, generationId: string, application: GenerationApplication): Promise<void> {
  const changedKeys = [...new Set([...before.blobs.keys(),...next.blobs.keys()])].filter((key) => before.blobs.get(key) !== next.blobs.get(key))
  const bytes = new Map(await Promise.all(changedKeys.filter((key) => next.blobs.has(key)).map(async (key) => [key,new Uint8Array(await next.blobs.get(key)!.arrayBuffer())] as const)))
  await sqliteTransaction(async () => {
    const current = await state(before.adaptation.id,false)
    const identity = JSON.parse(generationStateIdentity(current)) as Record<string,unknown>
    const prefix = `${before.adaptation.id}/`
    identity.blobs = (await exec('SELECT id,length(bytes),mime FROM native_blobs WHERE substr(id,1,?) = ? ORDER BY id',[prefix.length,prefix])).rows.map((row) => [String(row[0]),Number(row[1]),String(row[2])])
    if (JSON.stringify(identity) !== generationStateIdentity(before)) throw new Error('The adaptation changed while the replacement was being prepared. Review it again.')
    const receipt = `${before.adaptation.id}/journal/applied/${generationId}`
    if (current.texts.has(receipt)) throw new Error('This generation has already been applied.')
    for (const key of changedKeys) await writeBlob(key,next.blobs.get(key),bytes.get(key))
    const versions = {...next.adaptation.blobVersions}; for (const key of changedKeys) versions[key] = crypto.randomUUID()
    await put('adaptations',next.adaptation.id,{...next.adaptation,bytes:[...next.blobs.values()].reduce((sum,blob) => sum+blob.size,0),blobVersions:versions})
    for (const table of ['chapters','characters'] as const) {
      await exec(`DELETE FROM native_${table} WHERE adaptation_id = ?`,[before.adaptation.id])
      for (const row of next[table]) await put(table,row.id,row,row.adaptationId)
    }
    await exec('DELETE FROM native_texts WHERE substr(id,1,?) = ?',[before.adaptation.id.length+1,`${before.adaptation.id}/`])
    for (const [key,text] of next.texts) await put('texts',key,text)
    await put('texts',receipt,JSON.stringify(application))
  }); for (const key of changedKeys) blobChanged(key); changed()
}
export async function hasPendingGenerationApplication(id: string): Promise<boolean> { const prefix = `${id}/journal/applied/`; return (await exec('SELECT data FROM native_texts WHERE substr(id,1,?) = ?',[prefix.length,prefix])).rows.some((r) => (JSON.parse(JSON.parse(String(r[0]))) as GenerationApplication).phase === 'committed') }
