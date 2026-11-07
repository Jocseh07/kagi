import * as pipeline from '@/lib/adapt/pipeline'
import * as store from '@/lib/adapt/store'
import { slug } from '@/lib/adapt/prompts'
import { pageKey } from '@/lib/adapt/keys'
import { adaptedChapters, adaptedSeries, ADAPTED_SOURCE_ID } from '@/lib/sources/adapted'
import { upsertManga, upsertChapters, listChapters } from '@/lib/db/repositories'
import { ZipWriter, BlobWriter, BlobReader } from '@zip.js/zip.js'
import type { Params, Result } from '../protocol'
import { string, number } from '../protocol'
import { action, field } from '../screens/helpers'
import { mangaOf, sourceManga } from './library'
import type { MutationContext } from './context'

function parseDialogue(raw: string): store.TextItem[] {
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error('Enter a dialogue list with kind, line, and anchor.')
  return parsed.map((entry: unknown): store.TextItem => {
    if (!entry || typeof entry !== 'object' || !('kind' in entry) || !('line' in entry) || !('anchor' in entry)) throw new Error('Every dialogue entry needs kind, line, and anchor.')
    if (entry.kind !== 'speech' && entry.kind !== 'thought' && entry.kind !== 'caption' && entry.kind !== 'sfx') throw new Error('Choose speech, thought, caption, or sfx.')
    if (entry.anchor !== 'tl' && entry.anchor !== 'tr' && entry.anchor !== 'bl' && entry.anchor !== 'br') throw new Error('Choose tl, tr, bl, or br for the anchor.')
    if (typeof entry.line !== 'string') throw new Error('Every dialogue line must be text.')
    if ('speaker' in entry && typeof entry.speaker !== 'string') throw new Error('The speaker must be a character name.')
    const speakerAt = 'speakerAt' in entry ? entry.speakerAt : undefined
    if (speakerAt !== undefined && speakerAt !== 'left' && speakerAt !== 'center' && speakerAt !== 'right' && speakerAt !== 'off') throw new Error('Choose a valid speaker position.')
    return { kind: entry.kind, anchor: entry.anchor, line: entry.line, ...('speaker' in entry ? { speaker: entry.speaker as string } : {}), ...(speakerAt ? { speakerAt } : {}) }
  })
}

export async function adaptationAction(method: string, p: Params, values: Record<string, string>, selectedPaths: string[], context: MutationContext): Promise<Result | undefined> {
  if (!method.startsWith('adapt.')) return undefined
  const adaptationId = string(p.adaptationId)
  if (method === 'adapt.create.dialog') {
    const manga = await mangaOf(p)
    const chapters = await listChapters(manga.id)
    if (!chapters.length) throw new Error('Refresh this novel’s chapters before creating an adaptation.')
    return context.dialog({ id: 'create-adaptation', title: 'Create adaptation', description: `${manga.title} · ${chapters.length} novel chapters`, fields: [
      field('style', 'Art style', 'manga', 'select', [{ value: 'manga', label: 'Manga' }, { value: 'webtoon', label: 'Webtoon' }, { value: 'sketch', label: 'Sketch' }]),
      field('styleNotes', 'Style notes', '', 'multiline'), field('stopAt', 'Last novel chapter', chapters.length, 'number'),
      field('skipPrologue', 'Skip an unnecessary prologue', true, 'toggle'), field('checkPanels', 'Check drawn panels', false, 'toggle'),
    ], actions: [action('Start adaptation', 'adapt.create', { mangaId: manga.id })] })
  }
  if (method === 'adapt.create') {
    const manga = await mangaOf(p)
    if (manga.contentKind !== 'novel') throw new Error('Choose a novel to create an adaptation.')
    const chapters = await listChapters(manga.id)
    const style = values.style
    if (style !== 'manga' && style !== 'webtoon' && style !== 'sketch') throw new Error('Choose Manga, Webtoon, or Sketch.')
    const stopAt = values.stopAt?.trim() ? Number(values.stopAt) : undefined
    if (stopAt !== undefined && (!Number.isSafeInteger(stopAt) || stopAt < 1 || stopAt > chapters.length)) throw new Error('Choose a last chapter within this novel.')
    const existing = await store.findAdaptationByNovel(manga.sourceId, manga.url)
    if (existing) return context.navigate('adaptation', { adaptationId: existing.id })
    const created = await pipeline.createAdaptation(manga.sourceId, sourceManga(manga), chapters.length, { style, styleNotes: values.styleNotes ?? '', stopAt, skipPrologue: values.skipPrologue !== 'false', checkPanels: values.checkPanels === 'true' })
    return context.navigate('adaptation', { adaptationId: created.id, tab: 'progress' })
  }
  if (!adaptationId) throw new Error('Choose an adaptation first.')
  const adaptation = await store.getAdaptation(adaptationId)
  if (!adaptation) throw new Error('This adaptation no longer exists.')
  const chapter = number(p.chapter)
  const page = number(p.page)
  const panel = number(p.panel)
  switch (method) {
    case 'adapt.pause': await pipeline.pauseAdaptation(adaptationId); break
    case 'adapt.resume': await pipeline.resumeAdaptation(adaptationId); break
    case 'adapt.stop': await pipeline.stopAdaptation(adaptationId); break
    case 'adapt.delete':
      await pipeline.removeAdaptation(adaptationId)
      return context.navigate('adaptations')
    case 'adapt.range': {
      const stop = values.stopAt?.trim() ? Number(values.stopAt) : undefined
      if (stop !== undefined && (!Number.isSafeInteger(stop) || stop < 1 || stop > adaptation.novelChapterCount)) throw new Error('Choose a stop point within the novel.')
      const from = values.drawFrom?.trim() ? Number(values.drawFrom) : undefined
      const to = values.drawTo?.trim() ? Number(values.drawTo) : undefined
      if ((from === undefined) !== (to === undefined)) throw new Error('Enter both ends of the draw range.')
      if ((from !== undefined && (!Number.isSafeInteger(from) || from < 1)) || (to !== undefined && (!Number.isSafeInteger(to) || to < 1))) throw new Error('Use positive whole chapter numbers.')
      await pipeline.setStopAt(adaptationId, stop)
      await pipeline.setDrawRange(adaptationId, from !== undefined && to !== undefined ? { from, to } : undefined)
      break
    }
    case 'adapt.range.clear': await pipeline.setDrawRange(adaptationId, undefined); break
    case 'adapt.read': {
      const manga = await upsertManga(ADAPTED_SOURCE_ID, await adaptedSeries(adaptation))
      const chapters = await upsertChapters(manga.id, await adaptedChapters(adaptationId))
      const target = chapters.find((entry) => entry.chapterNumber === chapter)
      if (!target) throw new Error('This chapter has no drawn pages yet.')
      return context.navigate('reader', { mangaId: manga.id, chapterId: target.id })
    }
    case 'adapt.export': {
      const destination = selectedPaths[0]
      if (!destination) throw new Error('Choose where to save this chapter.')
      const keys = (await store.listPageKeys(adaptationId, chapter)).sort((a, b) => a - b)
      if (!keys.length) throw new Error('This chapter has no pages to export.')
      const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'), { useWebWorkers: false })
      for (const index of keys) {
        context.signal.throwIfAborted()
        const blob = await store.getBlob(pageKey(adaptationId, chapter, index))
        if (!blob) throw new Error(`Page ${index} is missing. Redraw it before exporting.`)
        const extension = blob.type === 'image/png' ? 'png' : blob.type === 'image/jpeg' ? 'jpg' : 'webp'
        await writer.add(`${String(index).padStart(4, '0')}.${extension}`, new BlobReader(blob), { level: 0 })
      }
      await Bun.write(destination, await writer.close())
      return { exportPath: destination, notice: 'Chapter exported.' }
    }
    case 'adapt.character':
    case 'adapt.character.redraw':
    case 'adapt.look.add': {
      const character = (await store.listCharacters(adaptationId)).find((entry) => entry.id === string(p.characterId))
      if (!character) throw new Error('This character no longer exists.')
      if (method === 'adapt.character.redraw') {
        const lookId = string(p.lookId)
        if (!character.looks.some((look) => look.id === lookId)) throw new Error('This look no longer exists.')
        await pipeline.updateCharacter(character, [lookId])
      } else if (method === 'adapt.look.add') {
        const name = (values.newLookName ?? '').trim()
        const change = (values.newLookChange ?? '').trim()
        if (!name || !change) throw new Error('Enter the look’s name and appearance change.')
        const id = `${character.id}@${slug(name)}`
        if (character.looks.some((look) => look.id === id)) throw new Error('A look with that name already exists.')
        await pipeline.updateCharacter({ ...character, looks: [...character.looks, { id, name, change, sheetKey: null }] }, [])
      } else {
        const name = (values.name ?? character.name).trim()
        if (!name) throw new Error('Enter a character name.')
        await pipeline.updateCharacter({ ...character, name, role: values.role ?? character.role, appearance: values.appearance ?? character.appearance, looks: character.looks.map((look) => ({ ...look, change: values[`look:${look.id}`] ?? look.change })) }, values.redraw === 'true' ? character.looks.map((look) => look.id) : [])
      }
      break
    }
    case 'adapt.reference': {
      const id = string(p.entityId)
      const description = values.description ?? ''
      if (p.entity === 'place') {
        const place = adaptation.places?.find((entry) => entry.id === id)
        if (!place) throw new Error('This place no longer exists.')
        const next = { ...place, name: (values.name ?? place.name).trim(), description }
        await store.patchPlace(adaptationId, id, { name: next.name, description })
        await pipeline.updatePlace(adaptationId, next, values.redraw === 'true')
      } else {
        const prop = adaptation.props?.find((entry) => entry.id === id)
        if (!prop) throw new Error('This object no longer exists.')
        const next = { ...prop, name: (values.name ?? prop.name).trim(), description }
        await store.patchProp(adaptationId, id, { name: next.name, description })
        await pipeline.updateProp(adaptationId, next, values.redraw === 'true')
      }
      break
    }
    case 'adapt.style': {
      const style = values.style
      if (style !== 'manga' && style !== 'webtoon' && style !== 'sketch') throw new Error('Choose Manga, Webtoon, or Sketch.')
      const scope = values.scope === 'all' ? 'all' : values.scope === 'from' ? Number(values.scopeStart) : 'new'
      if (typeof scope === 'number' && (!Number.isSafeInteger(scope) || scope < 1)) throw new Error('Choose a positive starting chapter.')
      await store.updateAdaptation(adaptationId, { skipPrologue: values.skipPrologue === 'true', checkPanels: values.checkPanels === 'true' })
      await pipeline.applyStyle(adaptationId, style, values.styleNotes ?? '', scope)
      break
    }
    case 'adapt.outfits': {
      for (const character of await store.listCharacters(adaptationId)) {
        const look = values[`wearing:${character.id}`] ?? ''
        if (look && !character.looks.some((entry) => entry.id === look)) throw new Error(`Choose an existing look for ${character.name}.`)
        await pipeline.setChapterOutfit(adaptationId, chapter, character.id, look || null)
      }
      break
    }
    case 'adapt.script.dialog': return context.dialog({ id: 'rewrite-script', title: 'Rewrite chapter script', fields: [field('note', 'Rewrite instructions', '', 'multiline')], actions: [action('Rewrite script', 'adapt.script.rewrite', { adaptationId, chapter }, { variant: 'danger', confirm: 'Replace this chapter’s storyboard and drawn pages? Saved journal originals remain.' })] })
    case 'adapt.script.rewrite': await pipeline.rewriteScript(adaptationId, chapter, values.note ?? ''); break
    case 'adapt.redraw.dialog': return context.dialog({ id: 'redraw-panel', title: panel ? 'Redraw panel' : 'Redraw page', fields: [field('note', 'Drawing instructions', '', 'multiline')], actions: [action(panel ? 'Redraw panel' : 'Redraw page', 'adapt.redraw', { adaptationId, chapter, page, ...(panel ? { panel } : {}) })] })
    case 'adapt.redraw':
      if (panel) await pipeline.requestPanelRedraw(adaptationId, chapter, page, panel, values.note ?? '')
      else await pipeline.requestRedraw(adaptationId, chapter, page, values.note ?? '')
      break
    case 'adapt.keep': await pipeline.keepPanel(adaptationId, chapter, page, panel); break
    case 'adapt.text.dialog': {
      const saved = await store.getChapter(adaptationId, chapter)
      const entry = saved?.script?.[page - 1]?.panels[panel - 1]
      if (!entry) throw new Error('This panel no longer exists.')
      return context.dialog({ id: 'panel-dialogue', title: 'Edit panel dialogue', fields: [field('dialogue', 'Dialogue and placement', JSON.stringify(entry.text, null, 2), 'multiline')], actions: [action('Save dialogue', 'adapt.text.save', { adaptationId, chapter, page, panel })] })
    }
    case 'adapt.text.save': await pipeline.updatePanelText(adaptationId, chapter, page, panel, parseDialogue(values.dialogue ?? '')); break
    default: throw new Error('This adaptation action is not available.')
  }
  return context.refresh()
}
