import { withGenerationReplacement } from '../pipeline'
import { commitGenerationState, getText, putText, readGenerationState } from '../store'
import { pageKey, panelKey, placeSheetKey, propSheetKey, sheetKey } from '../keys'
import type { BeatPart, Character, GenerationApplication, GenerationState, MangaChapter, ScriptPage, ScriptPart } from '../store'
import type { Plan } from '../planner'
import type { ChapterBeats } from '../beats'
import type { CheckResult } from '../check'
import { journalStore } from './store'
import { canonicalJson, hashBlob, resolveValidation } from './helpers'
import { validateReplayOutput, validationValue } from './validation'
import { jsonValue } from './runtime'
import type { GenerationRecord, GenerationStage, GenerationTarget, JournalOptions, JournalStore, JsonValue, ReplacementImpact } from './types'

interface Boundary {
  target: GenerationTarget
  stage: GenerationStage
  signature: string
  records: Record<string, string>
  inputs: string
}

export interface GenerationCapture {
  options: JournalOptions
  readonly recordId: string | undefined
  complete(): Promise<void>
}

function withoutSheets(characters: readonly Character[]) {
  return characters.map((character) => ({ ...character, looks: character.looks.map(({ sheetKey: _sheetKey, ...look }) => look) }))
}

function scriptIdentity(script: ScriptPage[] | null | undefined) {
  return script?.map((page) => ({ ...page, panels: page.panels.map(({ check: _check, ...panel }) => panel) }))
}

function imageKey(target: GenerationTarget): string {
  if (target.entityId && target.entityKind) {
    if (target.entityKind === 'character') return sheetKey(target.adaptationId, target.entityId)
    if (target.entityKind === 'prop') return propSheetKey(target.adaptationId, target.entityId)
    return placeSheetKey(target.adaptationId, target.entityId)
  }
  if (!target.chapter || !target.page || !target.panel) throw new Error('The generation has no complete image target.')
  return panelKey(target.adaptationId, target.chapter, target.page, target.panel)
}

function targetKey(target: GenerationTarget): string {
  return [target.chapter ?? '', target.page ?? '', target.panel ?? '', target.entityKind ?? '', target.entityId ?? ''].join(':')
}

export function generationPromptKey(target: GenerationTarget): string {
  return `${target.adaptationId}/journal/prompt/${targetKey(target)}`
}

function boundaryKey(target: GenerationTarget, operationId: string, stage: GenerationStage): string {
  return `${target.adaptationId}/journal/boundary/${operationId}/${stage}`
}

function currentKey(target: GenerationTarget, stage: GenerationStage): string {
  return `${target.adaptationId}/journal/current/${stage}/${targetKey(target)}`
}

function signature(state: GenerationState, stage: GenerationStage, target: GenerationTarget): string {
  const adaptation = state.adaptation
  const chapter = state.chapters.find((item) => item.number === target.chapter)
  const props = adaptation.props?.map(({ sheetKey: _sheetKey, ...prop }) => prop)
  const places = adaptation.places?.map(({ sheetKey: _sheetKey, ...place }) => place)
  const style = { style: adaptation.style, notes: adaptation.styleNotes }
  const source = { sourceId: adaptation.sourceId, novelUrl: adaptation.novelUrl, novelMemo: adaptation.novelMemo }
  const characters = withoutSheets(state.characters)
  if (stage === 'plan') return JSON.stringify({ source, style, characters, props, places, memory: adaptation.memory, readThrough: adaptation.readThrough, skipped: adaptation.skipped, chapters: state.chapters.map(({ number, novelChapters, summary, title, plan, contextMemory }) => ({ number, novelChapters, summary, title, plan, contextMemory })) })
  if (stage === 'beats' || stage === 'script') {
    if (!chapter) throw new Error('The generation chapter no longer exists.')
    return JSON.stringify({ source, style, characters, props, places, chapter: { number: chapter.number, novelChapters: chapter.novelChapters, summary: chapter.summary, contextMemory: chapter.contextMemory, beats: chapter.beats, cut: chapter.cut, beatParts: chapter.beatParts, ...(stage === 'script' ? { script: scriptIdentity(chapter.script), parts: chapter.scriptParts, note: chapter.scriptNote } : {}) } })
  }
  const key = imageKey(target)
  const revision = adaptation.blobVersions?.[key] ?? null
  const prompt = state.texts.get(generationPromptKey(target))
  if (target.entityKind) {
    const character = state.characters.find((item) => item.looks.some((look) => look.id === target.entityId))
    const entity = target.entityKind === 'character'
      ? character && { ...character, looks: character.looks.filter((look) => look.id === target.entityId) }
      : (target.entityKind === 'prop' ? adaptation.props : adaptation.places)?.find((item) => item.id === target.entityId)
    if (!entity) throw new Error('The reference-sheet target no longer exists.')
    const main = character?.looks.find((look) => look.id.endsWith('@main'))
    return JSON.stringify({ style, entity, revision, prompt, mainRevision: main?.sheetKey ? adaptation.blobVersions?.[main.sheetKey] : undefined })
  }
  const panel = chapter?.script?.[(target.page ?? 0) - 1]?.panels[(target.panel ?? 0) - 1]
  if (!panel) throw new Error('The generation panel no longer exists.')
  const references = [
    ...state.characters.flatMap((character) => character.looks.filter((look) => panel.looks.includes(look.id)).map((look) => ({ character: { ...character, looks: undefined }, look }))),
    ...(adaptation.props ?? []).filter((prop) => panel.props?.includes(prop.id)),
    ...(adaptation.places ?? []).filter((place) => panel.place === place.id),
  ]
  const keys = [
    ...state.characters.flatMap((character) => character.looks.filter((look) => panel.looks.includes(look.id)).flatMap((look) => look.sheetKey ? [look.sheetKey] : [])),
    ...(adaptation.props ?? []).filter((prop) => panel.props?.includes(prop.id)).flatMap((prop) => prop.sheetKey ? [prop.sheetKey] : []),
    ...(adaptation.places ?? []).filter((place) => panel.place === place.id).flatMap((place) => place.sheetKey ? [place.sheetKey] : []),
  ]
  const { check, ...scriptPanel } = panel
  return JSON.stringify({ style, panel: scriptPanel, references, revisions: keys.map((item) => [item, adaptation.blobVersions?.[item]]), revision, prompt, ...(stage === 'check' ? { check } : {}) })
}

function inputSignature(state: GenerationState, stage: GenerationStage, target: GenerationTarget): string {
  const value = JSON.parse(signature(state, stage, target)) as Record<string, unknown>
  if (stage === 'plan') return JSON.stringify({ source: value.source, style: value.style })
  if (stage === 'beats' || stage === 'script') {
    const chapter = value.chapter as Record<string, unknown>
    if (stage === 'beats') { delete chapter.beats; delete chapter.cut; delete chapter.beatParts }
    delete chapter.script
    delete chapter.parts
    delete chapter.note
  } else {
    delete value.revision
    delete value.check
    if (target.entityKind) {
      const entity = value.entity as Record<string, unknown>
      delete entity.sheetKey
      if (Array.isArray(entity.looks)) entity.looks = entity.looks.map(({ sheetKey: _sheetKey, ...look }) => look)
      if (target.entityId?.endsWith('@main')) delete value.mainRevision
    }
  }
  return JSON.stringify(value)
}

export async function captureGeneration(stage: GenerationStage, target: GenerationTarget): Promise<GenerationCapture> {
  const state = await readGenerationState(target.adaptationId, false)
  const fingerprint = await hashBlob(new Blob([signature(state, stage, target)]))
  const savedTarget = { ...target, fingerprint }
  const operationId = crypto.randomUUID()
  const inputs = inputSignature(state, stage, target)
  const records = new Set<string>()
  let latestRecord: string | undefined
  let completion: Promise<void> | undefined
  return {
    options: { context: { stage, target: savedTarget, operationId }, onRecord: (id) => { records.add(id); latestRecord = id } },
    get recordId() { return latestRecord },
    complete() {
      completion ??= (async () => {
        const current = await readGenerationState(target.adaptationId, false)
        const runs = await Promise.all([...records].map((id) => journalStore.getRun(id)))
        const stages: GenerationStage[] = stage === 'sheet' || stage === 'panel' ? [stage, 'prompt'] : [stage]
        for (const value of stages) {
          const validations: Record<string, string> = {}
          for (const run of runs) if (run?.stage === value) validations[run.id] = await validationHash(await resolveValidation(journalStore, run))
          const boundary: Boundary = { target: savedTarget, stage: value, signature: signature(current, value, savedTarget), records: validations, inputs }
          await putText(boundaryKey(savedTarget, operationId, value), JSON.stringify(boundary))
          await putText(currentKey(savedTarget, value), operationId)
        }
      })()
      return completion
    },
  }
}

/** Boundaries keep this hash of each run's resolved validation; older ones keep the validation JSON itself. */
async function validationHash(validation: JsonValue | undefined): Promise<string> {
  return hashBlob(new Blob([canonicalJson(validation)]))
}

async function requireBoundary(run: GenerationRecord, state: GenerationState, store: JournalStore): Promise<JsonValue | undefined> {
  if (run.status !== 'succeeded') throw new Error('Only a successful generation can replace a saved result.')
  if (!run.parentId) throw new Error('Replay the generation before applying a replacement.')
  if (run.appliedAt || state.texts.has(`${state.adaptation.id}/journal/applied/${run.id}`)) throw new Error('This generation has already been applied.')
  if (!run.target?.fingerprint || !run.operationId) throw new Error('This generation has no durable target provenance.')
  if (state.texts.get(currentKey(run.target, run.stage)) !== run.operationId) throw new Error('A newer generation owns this target.')
  const saved = state.texts.get(boundaryKey(run.target, run.operationId, run.stage))
  if (!saved) throw new Error('The original generation boundary is not available in this installation.')
  const boundary = JSON.parse(saved) as Boundary
  if (JSON.stringify(boundary.target) !== JSON.stringify(run.target) || boundary.stage !== run.stage) throw new Error('The replacement target does not match the original generation.')
  const validation = await resolveValidation(store, run)
  const hash = await validationHash(validation)
  const canonical = canonicalJson(validation)
  if (!Object.values(boundary.records ?? {}).some((record) => /^[a-f0-9]{64}$/.test(record) ? record === hash : canonicalJson(JSON.parse(record) as JsonValue) === canonical)) {
    throw new Error('The validation inputs do not match a locally recorded generation.')
  }
  if (boundary.inputs !== inputSignature(state, run.stage, run.target)) throw new Error('The generation inputs changed while its request was running.')
  if (boundary.signature !== signature(state, run.stage, run.target)) throw new Error('The target or its dependencies have changed. Replay the current generation instead.')
  return validation
}

export async function getReplacementImpact(run: GenerationRecord, store: JournalStore = journalStore): Promise<ReplacementImpact> {
  if (!run.target) throw new Error('This generation has no durable target.')
  const state = await readGenerationState(run.target.adaptationId, false)
  const pending = state.texts.get(`${run.target.adaptationId}/journal/applied/${run.id}`)
  if (pending && (JSON.parse(pending) as GenerationApplication).phase === 'committed') {
    return { title: run.target.title, details: ['The replacement is committed. Retry clearing published pages and downloads, then finish its journal receipt.', 'The replacement will not be applied again. The adaptation remains paused.'] }
  }
  await requireBoundary(run, state, store)
  const descriptions: Record<GenerationStage, string> = {
    plan: 'Replace this plan and its character, prop, place and memory changes. Remove later plans and their generated chapters.',
    beats: 'Replace the recorded passage. Discard later passage work, its storyboard, panels and composed pages.',
    script: 'Replace the recorded storyboard section. Discard later sections, panels, checks and composed pages.',
    sheet: 'Replace the reference sheet. Invalidate dependent variant sheets, panels, checks and composed pages.',
    panel: 'Replace this panel. Clear its check and composed page so the owning workflow checks and letters it again.',
    check: 'Replace the panel verdict. A failed verdict queues a redraw with the saved correction.',
    prompt: 'Save this prompt for the owning image workflow. Invalidate its image and dependent pages before regeneration.',
  }
  return { title: run.target.title, details: [descriptions[run.stage], 'Conflicting work is stopped and drained before replacement. The adaptation remains paused.', 'Original records and images are retained in the generation journal. Changed dependencies or repeated application are rejected.'] }
}

function resetChapter(state: GenerationState, chapter: MangaChapter, dropScript: boolean): void {
  const prefix = `${state.adaptation.id}/`
  for (const key of state.blobs.keys()) if (key.startsWith(`${prefix}page/${chapter.number}/`) || key.startsWith(`${prefix}panel/${chapter.number}/`)) state.blobs.delete(key)
  if (dropScript) { chapter.script = null; chapter.scriptParts = undefined }
  else if (chapter.script) chapter.script = chapter.script.map((page) => ({ ...page, panels: page.panels.map(({ check: _check, ...panel }) => panel) }))
  chapter.status = 'queued'
  chapter.error = null
  chapter.drawnAt = null
  chapter.redraw = []
  chapter.pageCount = 0
  chapter.panelsDone = 0
  chapter.panelsTotal = chapter.script?.reduce((sum, page) => sum + page.panels.length, 0) ?? 0
}

function invalidatePanel(state: GenerationState, chapter: MangaChapter, page: number, panel: number, removeImage: boolean): void {
  if (removeImage) state.blobs.delete(panelKey(state.adaptation.id, chapter.number, page, panel))
  state.blobs.delete(pageKey(state.adaptation.id, chapter.number, page))
  const target = chapter.script?.[page - 1]?.panels[panel - 1]
  if (target) target.check = undefined
  chapter.status = 'queued'
  chapter.error = null
  chapter.drawnAt = null
  chapter.pageCount = [...state.blobs.keys()].filter((key) => key.startsWith(`${state.adaptation.id}/page/${chapter.number}/`)).length
  chapter.panelsDone = chapter.script?.reduce((sum, value, index) => sum + (state.blobs.has(pageKey(state.adaptation.id, chapter.number, index + 1)) ? value.panels.length : 0), 0) ?? 0
  chapter.redraw = chapter.redraw.filter((request) => request.page !== page || (request.panel !== undefined && request.panel !== panel))
}

function replaceSheet(state: GenerationState, target: GenerationTarget, blob?: Blob): void {
  const key = imageKey(target)
  if (blob) state.blobs.set(key, blob)
  else state.blobs.delete(key)
  const affectedLooks = new Set<string>()
  if (target.entityKind === 'character') {
    const character = state.characters.find((item) => item.looks.some((look) => look.id === target.entityId))!
    for (const look of character.looks) {
      if (look.id === target.entityId) { look.sheetKey = blob ? key : null; affectedLooks.add(look.id) }
      else if (target.entityId?.endsWith('@main')) { if (look.sheetKey) state.blobs.delete(look.sheetKey); look.sheetKey = null; affectedLooks.add(look.id) }
    }
  } else {
    const entity = (target.entityKind === 'prop' ? state.adaptation.props : state.adaptation.places)?.find((item) => item.id === target.entityId)
    if (!entity) throw new Error('The reference-sheet target no longer exists.')
    entity.sheetKey = blob ? key : undefined
  }
  for (const chapter of state.chapters) chapter.script?.forEach((page, pageIndex) => page.panels.forEach((panel, panelIndex) => {
    if (panel.looks.some((look) => affectedLooks.has(look)) || (target.entityKind === 'prop' && panel.props?.includes(target.entityId!)) || (target.entityKind === 'place' && panel.place === target.entityId)) {
      invalidatePanel(state, chapter, pageIndex + 1, panelIndex + 1, true)
    }
  }))
}

function replaceText(state: GenerationState, run: GenerationRecord, validation: JsonValue | undefined): void {
  const value = validationValue({ ...run, output: validateReplayOutput(run, validation) })
  const target = run.target!
  const context = validation as { [key: string]: unknown }
  const chapter = state.chapters.find((item) => item.number === target.chapter)
  if (run.stage === 'plan') {
    const plan = value as unknown as Plan
    const original = context.adaptation as GenerationState['adaptation']
    const previous = context.previous as MangaChapter | undefined
    const from = (previous?.number ?? 0) + 1
    for (const item of state.chapters.filter((item) => item.number >= from)) resetChapter(state, item, true)
    state.chapters = [...state.chapters.filter((item) => item.number < from), ...plan.chapters]
    const cast = context.cast as Character[]
    const changes = new Map(plan.characters.map((item) => [item.id, item]))
    state.characters = [...cast.map((item) => changes.get(item.id) ?? item), ...plan.characters.filter((item) => !cast.some((known) => known.id === item.id))]
    state.adaptation.props = [...(original.props ?? []), ...plan.props]
    state.adaptation.places = [...(original.places ?? []), ...plan.places]
    state.adaptation.memory = plan.memory
    state.adaptation.readThrough = plan.memory.updatedThrough
    state.adaptation.skipped = [...original.skipped, ...plan.skip]
    const kept = new Set([...state.characters.flatMap((item) => item.looks.flatMap((look) => look.sheetKey ? [look.sheetKey] : [])), ...(state.adaptation.props ?? []).flatMap((item) => item.sheetKey ? [item.sheetKey] : []), ...(state.adaptation.places ?? []).flatMap((item) => item.sheetKey ? [item.sheetKey] : [])])
    for (const key of state.blobs.keys()) if (/\/(?:sheet|prop|place)\//.test(key) && !kept.has(key)) state.blobs.delete(key)
    return
  }
  if (run.stage === 'prompt') {
    state.texts.set(generationPromptKey(target), value as string)
    if (target.entityKind) replaceSheet(state, target)
    else if (chapter) invalidatePanel(state, chapter, target.page!, target.panel!, true)
    return
  }
  if (!chapter) throw new Error('The generation chapter no longer exists.')
  if (run.stage === 'check') {
    const result = value as unknown as CheckResult
    const panel = chapter.script?.[target.page! - 1]?.panels[target.panel! - 1]
    if (!panel) throw new Error('The generation panel no longer exists.')
    panel.check = { status: result.ok ? 'passed' : 'flagged', issue: result.issue, tries: panel.check?.tries ?? 0 }
    if (!result.ok) {
      chapter.redraw = [...chapter.redraw.filter((item) => item.page !== target.page || item.panel !== target.panel), { id: crypto.randomUUID(), page: target.page!, panel: target.panel!, note: result.issue ?? '' }]
      chapter.status = 'queued'
      chapter.error = null
    }
    return
  }
  const span = context.span as { from: number; to: number } | undefined
  if (!span || !Number.isInteger(span.from) || !Number.isInteger(span.to) || span.from < 0 || span.to <= span.from) throw new Error('The original section boundary is missing or invalid.')
  if (run.stage === 'beats') {
    const result = value as unknown as ChapterBeats
    const kept = (chapter.beatParts ?? []).filter((part) => part.to <= span.from)
    if (span.from > 0 && kept.at(-1)?.to !== span.from) throw new Error('Earlier beat passage boundaries are missing.')
    const part: BeatPart = { ...span, ...result }
    chapter.beatParts = [...kept, part]
    chapter.beats = null
    chapter.cut = []
    resetChapter(state, chapter, true)
  } else if (run.stage === 'script') {
    const kept = (chapter.scriptParts ?? []).filter((part) => part.to <= span.from)
    if (span.from > 0 && kept.at(-1)?.to !== span.from) throw new Error('Earlier storyboard section boundaries are missing.')
    const pages = (value as unknown as ScriptPage[]).map((page) => ({ ...page, panels: page.panels.map((panel) => ({ ...panel, beat: (panel.beat ?? 0) + span.from })) }))
    const part: ScriptPart = { ...span, pages }
    resetChapter(state, chapter, true)
    chapter.scriptParts = [...kept, part]
  }
}

async function retainOriginal(store: JournalStore, run: GenerationRecord, state: GenerationState): Promise<string[]> {
  const ids: string[] = []
  const save = async (blob: Blob, name?: string) => {
    const id = crypto.randomUUID()
    await store.putArtifact({ id, generationId: run.id, name: name ?? `original-${id}.bin`, mime: blob.type || 'application/octet-stream', size: blob.size, sha256: await hashBlob(blob), blob })
    ids.push(id)
    return id
  }
  const blobs: Record<string, string> = {}
  for (const [key, blob] of state.blobs) blobs[key] = await save(blob)
  await save(new Blob([JSON.stringify({ adaptation: state.adaptation, characters: state.characters, chapters: state.chapters, texts: [...state.texts], blobs })], { type: 'application/json' }), 'original-state.json')
  return ids
}

export async function applyGeneration(run: GenerationRecord, store: JournalStore = journalStore): Promise<void> {
  if (!run.target) throw new Error('This generation has no durable target.')
  await withGenerationReplacement(run.target.adaptationId, async () => {
    const before = await readGenerationState(run.target!.adaptationId)
    const existing = before.texts.get(`${run.target!.adaptationId}/journal/applied/${run.id}`)
    if (existing) {
      const application = JSON.parse(existing) as GenerationApplication
      if (application.phase === 'complete') throw new Error('This generation has already been applied.')
      return application.affected
    }
    const validation = await requireBoundary(run, before, store)
    const next: GenerationState = { adaptation: structuredClone(before.adaptation), chapters: structuredClone(before.chapters), characters: structuredClone(before.characters), blobs: new Map(before.blobs), texts: new Map(before.texts) }
    next.adaptation.status = 'paused'
    next.adaptation.error = null
    if (run.stage === 'sheet' || run.stage === 'panel') {
      const artifact = run.outputArtifactId ? await store.getArtifact(run.outputArtifactId) : undefined
      if (!artifact || artifact.generationId !== run.id || !artifact.mime.startsWith('image/') || !artifact.blob.size || await hashBlob(artifact.blob) !== artifact.sha256) throw new Error('The replacement image is missing or failed its integrity check.')
      if (run.stage === 'sheet') replaceSheet(next, run.target!, artifact.blob)
      else {
        const chapter = next.chapters.find((item) => item.number === run.target!.chapter)
        if (!chapter) throw new Error('The generation chapter no longer exists.')
        next.blobs.set(imageKey(run.target!), artifact.blob)
        invalidatePanel(next, chapter, run.target!.page!, run.target!.panel!, false)
      }
    } else replaceText(next, run, validation)
    next.texts.delete(currentKey(run.target!, run.stage))
    const originals = await retainOriginal(store, run, before)
    const affectedSet = new Set([...before.chapters, ...next.chapters].filter((chapter) => {
      const old = before.chapters.find((item) => item.number === chapter.number)
      const replacement = next.chapters.find((item) => item.number === chapter.number)
      return JSON.stringify(old) !== JSON.stringify(replacement)
    }).map((chapter) => chapter.number))
    for (const key of new Set([...before.blobs.keys(), ...next.blobs.keys()])) {
      if (before.blobs.get(key) === next.blobs.get(key)) continue
      const match = /\/(?:page|panel)\/(\d+)\//.exec(key)
      if (match) affectedSet.add(Number(match[1]))
    }
    const affected = [...affectedSet].sort((a, b) => a - b)
    await commitGenerationState(before, next, run.id, { at: Date.now(), affected, originals, phase: 'committed' })
    return affected
  })
  const key = `${run.target.adaptationId}/journal/applied/${run.id}`
  const saved = await getText(key)
  if (!saved) throw new Error('The committed application receipt is missing.')
  const application = JSON.parse(saved) as GenerationApplication
  const events = await store.getEvents(run.id)
  if (!events.some((event) => event.kind === 'applied')) {
    await store.putEvent({ id: crypto.randomUUID(), generationId: run.id, sequence: Math.max(0, ...events.map((event) => event.sequence)) + 1, at: application.at, kind: 'applied', data: jsonValue({ originals: application.originals, affected: application.affected }) })
  }
  await store.putRun({ ...run, appliedAt: application.at, updatedAt: Date.now() })
  await putText(key, JSON.stringify({ ...application, phase: 'complete' }))
}

export async function savedGenerationPrompt(target: GenerationTarget): Promise<string | undefined> {
  return getText(generationPromptKey(target))
}
