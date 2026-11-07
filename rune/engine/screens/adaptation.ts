import * as store from '@/lib/adapt/store'
import { getAdaptActivity } from '@/lib/adapt/pipeline'
import { pageKey, panelKey } from '@/lib/adapt/keys'
import { getSource } from '@/lib/sources/registry'
import { journalStore } from '@/lib/adapt/journal/store'
import type { GenerationRecord } from '@/lib/adapt/journal/types'
import type { Params, Section, Row } from '../protocol'
import { number, string } from '../protocol'
import { cacheBlobImage } from '../adapters/image-runtime'
import { action, field, choices, navigate, section, tabs, date, bytes } from './helpers'

const references = new Map<string, { version: string; path: string }>()

export function clearReferenceImages(): void {
  references.clear()
}

async function referenceImage(adaptation: store.Adaptation, key: string | null | undefined): Promise<string | undefined> {
  if (!key) return undefined
  const version = adaptation.blobVersions?.[key] ?? ''
  const previous = references.get(key)
  if (previous?.version === version) return previous.path
  const blob = await store.getBlob(key)
  if (!blob) return undefined
  const image = await cacheBlobImage(`${key}:${version}`, blob)
  references.delete(key)
  references.set(key, { version, path: image.path })
  if (references.size > 128) {
    const oldest = references.keys().next().value
    if (oldest !== undefined) references.delete(oldest)
  }
  return image.path
}

export const adaptationTabs = (p: Params) => tabs('adaptation', string(p.tab, 'progress'), [['read', 'Read'], ['progress', 'Progress'], ['cast', 'Cast'], ['props', 'Props'], ['style', 'Style']], { adaptationId: string(p.adaptationId) })

export async function adaptationList(): Promise<Section[]> {
  const list = await store.listAdaptations()
  return [section('adaptations', 'Your adaptations', await Promise.all(list.map(async (entry): Promise<Row> => {
    const chapters = await store.listChapters(entry.id)
    const drawn = chapters.filter((chapter) => chapter.drawnAt !== null).length
    return {
      id: entry.id, title: entry.title, subtitle: `${drawn} drawn chapters · ${entry.status} · ${getSource(entry.sourceId).name}`,
      badges: entry.error ? ['Needs attention'] : [],
      actions: [navigate('Open adaptation', 'adaptation', { adaptationId: entry.id }, true), action(entry.status === 'active' ? 'Pause generation' : 'Resume generation', entry.status === 'active' ? 'adapt.pause' : 'adapt.resume', { adaptationId: entry.id }, { variant: 'secondary' })],
    }
  })), 'Choose a novel and create an adaptation.', [navigate('Browse novels', 'browse', { kind: 'novel' })])]
}

export async function adaptationSections(p: Params): Promise<Section[]> {
  const adaptationId = string(p.adaptationId)
  const adaptation = await store.getAdaptation(adaptationId)
  if (!adaptation) throw new Error('This adaptation no longer exists. Choose another adaptation.')
  const [chapters, characters] = await Promise.all([store.listChapters(adaptationId), store.listCharacters(adaptationId)])
  const tab = string(p.tab, 'progress')
  if (tab === 'style') return [{
    id: 'adapt-style', title: 'Art direction', status: 'ready', layout: 'form',
    fields: [
      field('style', 'Art style', adaptation.style, 'select', [{ value: 'manga', label: 'Manga' }, { value: 'webtoon', label: 'Webtoon' }, { value: 'sketch', label: 'Sketch' }]),
      field('styleNotes', 'Style notes', adaptation.styleNotes, 'multiline'),
      field('scope', 'Apply to', 'new', 'select', [{ value: 'new', label: 'New chapters only' }, { value: 'all', label: 'All sheets and drawn chapters' }, { value: 'from', label: 'From a drawn chapter' }]),
      field('scopeStart', 'Starting chapter', 1, 'number'),
      field('skipPrologue', 'Skip an unnecessary prologue', adaptation.skipPrologue, 'toggle'),
      field('checkPanels', 'Check drawn panels', adaptation.checkPanels, 'toggle'),
    ], actions: [action('Save art direction', 'adapt.style', { adaptationId })],
  }]
  if (tab === 'cast') {
    const result = [section('adapt-cast', 'Cast and looks', characters.map((character): Row => ({
      id: character.id, title: character.name, subtitle: `${character.role} · ${character.looks.length} looks · First seen in novel chapter ${character.firstNovelChapter}`,
      actions: [navigate('Edit character', 'adaptation', { adaptationId, tab: 'cast', who: character.id })],
    })), 'Characters appear after planning runs.')]
    const selected = characters.find((character) => character.id === p.who)
    if (selected) {
      result.push({ id: 'cast-editor', title: selected.name, status: 'ready', layout: 'form', fields: [
        field('name', 'Name', selected.name), field('role', 'Role', selected.role), field('appearance', 'Appearance', selected.appearance, 'multiline'),
        ...selected.looks.map((look) => field(`look:${look.id}`, `${look.name}: appearance change`, look.change, 'multiline')),
        field('redraw', 'Redraw reference sheets', false, 'toggle'),
      ], actions: [action('Save character', 'adapt.character', { adaptationId, characterId: selected.id })] })
      result.push(section('cast-references', 'Reference sheets', await Promise.all(selected.looks.map(async (look): Promise<Row> => ({
        id: look.id, title: look.name, subtitle: look.change || selected.appearance,
        image: await referenceImage(adaptation, look.sheetKey),
        badges: look.sheetKey ? [] : ['Not drawn yet'],
        actions: [action('Redraw this look', 'adapt.character.redraw', { adaptationId, characterId: selected.id, lookId: look.id }, { variant: 'secondary' })],
      }))), 'No looks planned yet.'))
    }
    return result
  }
  if (tab === 'props') {
    const entries = [...(adaptation.props ?? []).map((item) => ({ ...item, entity: 'prop' })), ...(adaptation.places ?? []).map((item) => ({ ...item, entity: 'place' }))]
    const result = [section('adapt-props', 'Objects and places', entries.map((entry): Row => ({
      id: entry.id, title: entry.name, subtitle: entry.description,
      actions: [navigate('Edit reference', 'adaptation', { adaptationId, tab: 'props', item: entry.id, entity: entry.entity })],
    })), 'Recurring objects and places appear after planning.')]
    const selected = entries.find((entry) => entry.id === p.item)
    if (selected) {
      result.push({ id: 'prop-editor', title: selected.name, status: 'ready', layout: 'form', fields: [field('name', 'Name', selected.name), field('description', 'Description', selected.description, 'multiline'), field('redraw', 'Redraw reference sheet', false, 'toggle')], actions: [action('Save reference', 'adapt.reference', { adaptationId, entityId: selected.id, entity: selected.entity })], rows: [{ id: `${selected.id}:sheet`, title: 'Reference sheet', image: await referenceImage(adaptation, selected.sheetKey), subtitle: selected.sheetKey ? 'Saved reference' : 'Not drawn yet' }] })
    }
    return result
  }
  if (tab === 'read') return [section('adapt-read', 'Drawn chapters', chapters.filter((chapter) => chapter.drawnAt !== null).map((chapter): Row => ({
    id: chapter.id, title: `Chapter ${chapter.number}: ${chapter.title}`, subtitle: `${chapter.pageCount} pages`,
    actions: [action('Read chapter', 'adapt.read', { adaptationId, chapter: chapter.number }, { variant: 'primary' }), action('Export chapter', 'adapt.export', { adaptationId, chapter: chapter.number }, { variant: 'secondary', pick: 'save' })],
  })), 'Drawn chapters appear here as generation finishes.', [navigate('View progress', 'adaptation', { adaptationId, tab: 'progress' })])]
  const activity = getAdaptActivity(adaptationId)
  const totalPanels = chapters.reduce((sum, chapter) => sum + chapter.panelsTotal, 0)
  const donePanels = chapters.reduce((sum, chapter) => sum + chapter.panelsDone, 0)
  const lanes = [
    ...(activity.reading ? [`Reading novel chapters ${activity.reading[0]} to ${activity.reading[1]}`] : []),
    ...(activity.scripting.length ? [`Scripting chapters ${activity.scripting.join(', ')}`] : []),
    ...(activity.drawing.length ? [`Drawing chapters ${activity.drawing.join(', ')}`] : []),
    ...(activity.redrawing.length ? [`Redrawing chapters ${activity.redrawing.join(', ')}`] : []),
  ]
  const result: Section[] = [
    section('adapt-status', adaptation.status === 'active' ? 'Generation progress' : adaptation.status === 'paused' ? 'Generation paused' : 'Generation stopped', [{
      id: 'adapt-status-row', title: adaptation.title,
      subtitle: adaptation.error ?? (lanes.join('\n') || `${adaptation.readThrough} of ${adaptation.novelChapterCount} novel chapters read`),
      detail: `${donePanels} of ${totalPanels} panels drawn · ${bytes(adaptation.bytes ?? 0)}`,
      ...(totalPanels > 0 ? { progress: donePanels / totalPanels } : {}),
      actions: [action(adaptation.status === 'active' ? 'Pause generation' : 'Resume generation', adaptation.status === 'active' ? 'adapt.pause' : 'adapt.resume', { adaptationId }), action('Stop generation', 'adapt.stop', { adaptationId }, { variant: 'secondary' }), navigate('Open journal', 'journal', { adaptationId })],
    }], ''),
    { id: 'adapt-range', title: 'Generation range', status: 'ready', layout: 'form', fields: [
      field('stopAt', 'Last novel chapter', adaptation.stopAt ?? '', 'number'),
      field('drawFrom', 'Draw from manga chapter', adaptation.drawRange?.from ?? '', 'number'),
      field('drawTo', 'Draw through manga chapter', adaptation.drawRange?.to ?? '', 'number'),
    ], actions: [action('Save chapter range', 'adapt.range', { adaptationId }), action('Clear draw range', 'adapt.range.clear', { adaptationId }, { variant: 'secondary' })] },
    section('adapt-chapters', 'Chapters', chapters.map((chapter): Row => ({
      id: chapter.id, title: `Chapter ${chapter.number}: ${chapter.title}`,
      subtitle: chapter.error ?? `${chapter.status} · ${chapter.panelsDone} of ${chapter.panelsTotal} panels`,
      ...(chapter.panelsTotal > 0 ? { progress: chapter.panelsDone / chapter.panelsTotal } : {}),
      actions: [
        navigate('Inspect chapter', 'adaptation', { adaptationId, tab: 'progress', chapter: chapter.number }),
        ...(chapter.drawnAt !== null ? [action('Read chapter', 'adapt.read', { adaptationId, chapter: chapter.number }, { variant: 'primary' })] : []),
        action('Rewrite script', 'adapt.script.dialog', { adaptationId, chapter: chapter.number }, { variant: 'secondary' }),
      ],
    })), 'The planner has not created chapters yet.'),
  ]
  const selected = chapters.find((chapter) => chapter.number === number(p.chapter, -1))
  if (selected) {
    result.push({ id: 'chapter-outfits', title: `${selected.title}: outfits`, status: 'ready', layout: 'form', fields: characters.map((character) => field(`wearing:${character.id}`, character.name, selected.wearing?.[character.id] ?? '', 'select', [{ value: '', label: 'Follow the story' }, ...character.looks.map((look) => ({ value: look.id, label: look.name }))])), actions: [action('Save chapter outfits', 'adapt.outfits', { adaptationId, chapter: selected.number })] })
    const rows: Row[] = []
    for (const [pageIndex, page] of (selected.script ?? []).entries()) {
      rows.push({ id: `${selected.id}:page:${pageIndex}`, title: `Page ${pageIndex + 1}`, image: await referenceImage(adaptation, pageKey(adaptationId, selected.number, pageIndex + 1)), actions: [action('Redraw page', 'adapt.redraw.dialog', { adaptationId, chapter: selected.number, page: pageIndex + 1 }, { variant: 'secondary' })] })
      for (const [panelIndex, panel] of page.panels.entries()) rows.push({
        id: `${selected.id}:panel:${pageIndex}:${panelIndex}`, title: `Page ${pageIndex + 1}, panel ${panelIndex + 1}`,
        subtitle: panel.shot, detail: panel.text.map((entry) => entry.speaker ? `${entry.speaker}: ${entry.line}` : entry.line).join('\n'),
        image: await referenceImage(adaptation, panelKey(adaptationId, selected.number, pageIndex + 1, panelIndex + 1)),
        badges: panel.check?.status === 'flagged' ? ['Flagged for review'] : [],
        actions: [
          action('Edit dialogue', 'adapt.text.dialog', { adaptationId, chapter: selected.number, page: pageIndex + 1, panel: panelIndex + 1 }),
          action('Redraw panel', 'adapt.redraw.dialog', { adaptationId, chapter: selected.number, page: pageIndex + 1, panel: panelIndex + 1 }, { variant: 'secondary' }),
          ...(panel.check?.status === 'flagged' ? [action('Keep this panel', 'adapt.keep', { adaptationId, chapter: selected.number, page: pageIndex + 1, panel: panelIndex + 1 }, { variant: 'secondary' })] : []),
        ],
      })
    }
    result.push(section('chapter-panels', 'Script and panels', rows, 'This chapter is waiting for a script.'))
  }
  return result
}

function runRow(run: GenerationRecord): Row {
  const target = run.target
  return { id: run.id, title: target ? `${target.title}${target.chapter ? ` · Chapter ${target.chapter}` : ''}${target.page ? `, page ${target.page}` : ''}${target.panel ? `, panel ${target.panel}` : ''}` : run.stage,
    subtitle: `${run.stage} · ${run.model} · ${date(run.createdAt)}`, badges: [run.status],
    actions: [navigate('Inspect generation', 'generation', { generationId: run.id })] }
}

export async function journalSections(p: Params): Promise<Section[]> {
  const all = await journalStore.listRuns()
  const query = string(p.query).toLocaleLowerCase()
  const list = all.filter((run) => (!p.adaptationId || run.target?.adaptationId === p.adaptationId) && (!p.stage || run.stage === p.stage) && (!p.status || run.status === p.status) && (!query || `${run.model} ${run.target?.title ?? ''} ${run.id}`.toLocaleLowerCase().includes(query)))
  return [
    { id: 'journal-filters', title: 'Find a generation', status: 'ready', layout: 'form', fields: [
      field('query', 'Search generations', string(p.query)), field('stage', 'Stage', string(p.stage), 'select', [{ value: '', label: 'All stages' }, ...choices(['plan', 'beats', 'script', 'sheet', 'panel', 'check', 'prompt'])]),
      field('status', 'Status', string(p.status), 'select', [{ value: '', label: 'All statuses' }, ...choices(['running', 'succeeded', 'failed', 'cancelled', 'interrupted'])]),
    ], actions: [action('Apply filters', 'journal.filter', { ...(p.adaptationId ? { adaptationId: p.adaptationId } : {}) }), action('Import journal', 'journal.import', {}, { variant: 'secondary', pick: 'file', accept: ['zip'] }), action('Export journal', 'journal.export', {}, { variant: 'secondary', pick: 'save' })] },
    section('journal-runs', `${list.length} generations`, list.map(runRow), 'Generation requests appear here when you start an adaptation.'),
  ]
}

export async function generationSections(p: Params): Promise<Section[]> {
  const id = string(p.generationId)
  const run = await journalStore.getRun(id)
  if (!run) throw new Error('This generation no longer exists. Import its journal bundle or choose another.')
  const [events, artifacts, related] = await Promise.all([journalStore.getEvents(id), journalStore.getArtifacts(id), journalStore.listRuns()])
  const comparisons = related.filter((entry) => entry.id !== id && (entry.parentId === id || entry.id === run.parentId || (run.parentId && entry.parentId === run.parentId)))
  const output: Row[] = [{ ...runRow(run), actions: [], ...(run.error ? { detail: run.error } : {}) }]
  if (run.output !== undefined && p.inspect === 'output') output.push({ id: 'output-json', title: 'Saved output', detail: JSON.stringify(run.output, null, 2) })
  for (const artifact of artifacts) if (artifact.mime.startsWith('image/')) output.push({ id: artifact.id, title: artifact.name, image: (await cacheBlobImage(artifact.id, artifact.blob)).path, subtitle: bytes(artifact.size) })
  const result: Section[] = [
    section('generation-output', 'Output', output, 'No output was recorded.', [navigate('Inspect saved output', 'generation', { generationId: id, inspect: 'output' }), navigate('Inspect saved request', 'generation', { generationId: id, inspect: 'request' })]),
    { id: 'generation-retry', title: 'Retry generation', status: 'ready', layout: 'form', fields: [
      field('model', 'Model', run.model), field('prompt', 'Prompt override', '', 'multiline'),
      field('attempt', 'Saved input', '', 'select', [{ value: '', label: 'Original request' }, ...[...new Set(events.filter((entry) => entry.kind === 'request' && entry.attempt !== undefined).map((entry) => entry.attempt!))].map((attempt) => ({ value: String(attempt), label: `Attempt ${attempt}` }))]),
      field('comparison', 'Compare with', string(p.comparison), 'select', [{ value: '', label: 'Choose a related generation' }, ...comparisons.map((entry) => ({ value: entry.id, label: `${entry.status} · ${date(entry.createdAt)}` }))]),
    ], actions: [action('Run comparison', 'generation.retry', { generationId: id }), navigate('Open comparison', 'generation', { generationId: id, compareFromField: true }), ...(run.status === 'succeeded' && run.target && !run.appliedAt ? [action('Review replacement', 'generation.review', { generationId: id }, { variant: 'secondary' })] : [])] },
    section('generation-attempts', 'Attempts and raw output', events.map((event): Row => ({ id: event.id, title: `${event.attempt ? `Attempt ${event.attempt}: ` : ''}${event.kind}`, subtitle: `${date(event.at)}${event.status ? ` · HTTP ${event.status}` : ''}`, detail: event.message, actions: event.artifactId ? [action('Export evidence', 'generation.artifact', { generationId: id, artifactId: event.artifactId }, { variant: 'secondary', pick: 'save' })] : [] })), 'No attempt events were recorded.'),
    section('generation-files', 'Saved files', artifacts.map((artifact): Row => ({ id: artifact.id, title: artifact.name, subtitle: `${artifact.mime} · ${bytes(artifact.size)}`, actions: [action('Export saved file', 'generation.artifact', { generationId: id, artifactId: artifact.id }, { variant: 'secondary', pick: 'save' })] })), 'No files were recorded.', [action('Export generation', 'journal.export', { generationId: id }, { variant: 'secondary', pick: 'save' }), ...(run.status !== 'running' ? [action('Delete journal record', 'generation.delete', { generationId: id }, { variant: 'danger', confirm: 'Delete this record, requests, responses, and saved journal files? Adaptation content remains.' })] : [])]),
  ]
  if (p.inspect === 'request') result.splice(1, 0, section('generation-request', 'Saved request', [{ id: 'request', title: run.request?.path ?? 'Request unavailable', detail: JSON.stringify(run.request ?? null, null, 2) }], 'No request was recorded.'))
  const comparisonId = string(p.comparison)
  if (comparisonId) {
    const comparison = await journalStore.getRun(comparisonId)
    if (!comparison) throw new Error('The comparison generation is missing. Import its journal bundle.')
    result.splice(1, 0, section('generation-comparison', 'Comparison generation', [runRow(comparison), ...(await journalStore.getArtifacts(comparisonId)).filter((artifact) => artifact.mime.startsWith('image/')).map((artifact) => ({ id: artifact.id, title: artifact.name }))], 'No output was recorded.'))
  }
  return result
}
