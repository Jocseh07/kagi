import { textSections } from './beats'
import { captureValidation } from './journal/validation'
import { jsonValue } from './journal/runtime'
import type { Span } from './parts'
import type { JsonObject } from './journal/types'
import { MalformedReplyError, chatJson, createTextStageSignal, malformedFeedback, replyExcerpt } from './client'
import type { ChatOptions } from './client'
import { clean, slug } from './prompts'
import type { AdaptSettings } from './settings'
import { chapterId } from './keys'
import type { Adaptation, Character, MangaChapter, NovelChapterRef, Place, Prop, PropKind, StoryMemory } from './store'

export interface BatchChapter {
  ref: NovelChapterRef
  text: string
  /** Set when a chapter is too long for one request and is read in parts; only its last part plans manga chapters. */
  part?: { index: number; total: number }
  /** Manga chapters a source chapter longer than `MAX_CHAPTER_TEXT_CHARS` is cut into, outside fast mode. */
  mangaParts?: number
}

interface PlanDraft {
  skip?: number[]
  chapters?: { title?: string; novelChapters?: number[]; summary?: string; wearing?: Record<string, string> }[]
  characters?: {
    id?: string
    name?: string
    role?: string
    appearance?: string
    now?: string
    looks?: { id?: string; name?: string; change?: string }[]
  }[]
  props?: { id?: string; name?: string; kind?: string; description?: string }[]
  places?: { id?: string; name?: string; description?: string }[]
  memory?: { summary?: string; threads?: string[] }
}

export interface Plan {
  skip: number[]
  chapters: MangaChapter[]
  characters: Character[]
  /** New props only; existing ones are never redescribed. */
  props: Prop[]
  /** New places only. */
  places: Place[]
  memory: StoryMemory
}

const PROP_KINDS: readonly PropKind[] = ['vehicle', 'object', 'creature']
const MAX_NEW_PROPS = 4
const MAX_NEW_PLACES = 4
const MAX_SUMMARY_WORDS = 300
/** Novel text one planner request reads; a longer batch is planned in groups that carry memory and cast forward. */
const MAX_PLAN_TEXT_CHARS = 120_000
/** Novel text one manga chapter adapts, about two web novel chapters; past it the beats outgrow what a storyboard can show. */
export const MAX_CHAPTER_TEXT_CHARS = 20_000

/** Where a source chapter is cut into manga chapters; the same text always cuts the same way. */
export function sourceSections(text: string): Span[] {
  return textSections(text, MAX_CHAPTER_TEXT_CHARS)
}

/** The novel text one manga chapter adapts from `text`, the whole source chapter. */
export function sourcePart(text: string, part: NovelChapterRef['part']): string {
  if (!part) return text
  const span = sourceSections(text)[part.index - 1]
  return span ? text.slice(span.from, span.to) : ''
}

const SYSTEM = `You plan a manga adaptation of a web novel, a few chapters at a time, and keep the story memory every later step reads.
Return only JSON: {"skip": number[], "chapters": [{"title": string, "novelChapters": number[], "summary": string, "wearing": {"<character id>": "<look id>"}}], "characters": [{"id": string, "name": string, "role": string, "appearance": string, "now": string, "looks": [{"id": string, "name": string, "change": string}]}], "props": [{"id": string, "name": string, "kind": "vehicle"|"object"|"creature", "description": string}], "places": [{"id": string, "name": string, "description": string}], "memory": {"summary": string, "threads": string[]}}.
- skip: novel chapter numbers from this batch to leave out, only for a prologue, author notes or recap that adds nothing to show. Use [] unless the instructions allow skipping.
- chapters: new manga chapters covering every chapter of this batch that is not skipped, in order, each novel chapter exactly once. Usually 1 or 2 novel chapters per manga chapter. Title 2 to 5 words. Summary one sentence.
- wearing: for each recurring character on screen in that chapter, the look id (such as "main" or "tournament") they wear for the whole chapter, from their existing looks or the looks you add. Leave out a character who changes clothes partway through the chapter.
- characters: every recurring character seen on screen in this batch who is not in the existing cast, plus every existing character who appears in this batch. For an existing character reuse their id exactly and list only looks they did not have (often none). A new character's id is a lowercase slug of their name, and their looks include one with id "main".
- appearance: 50 to 80 words fixing the look for every image: apparent age, build, face, eye colour, hair colour, length and style, skin, outfit with colours and materials, signature props. Quote the novel's own descriptions, and pick one concrete answer for anything it leaves out.
- now: one line on where the character stands at the end of this batch: current look, place, injuries, items carried.
- looks: id is a short lowercase slug such as "main", "child", "disguise", "uniform", "tournament". name reads like "Main, 19", "Child, 8" or "Tournament robes". change says what differs from the main look, and is empty for "main". Add a look whenever a character wears different clothes for a scene: a uniform, formal wear, armour, sleepwear, a disguise, or clothes the novel describes as new. Its change names the whole outfit with colours and materials, so it replaces the main outfit. Reuse an existing look when the character wears it again.
- Leave out crowds and one-off extras.
- props: at most ${MAX_NEW_PROPS} new ones per batch, most important first: vehicles characters ride in, signature objects (weapons, keys, phones, jewellery) and recurring animals (pets, mounts, familiars), when they appear in more than one scene or matter to the plot, and are not in the existing props. Never places, outfits, crowds, food, furniture or one-off items. id is a short lowercase slug such as "ji-car". description is 30 to 60 words fixing one concrete design for every image: make and model or type, colours, materials. For a vehicle cover the exterior, the interior and its key; for an animal its size, colours and markings. Quote the novel, and pick one answer for anything it leaves out. Never redescribe an existing prop.
- places: at most ${MAX_NEW_PLACES} new ones per batch: settings scenes return to (homes, offices, halls, streets) that are not in the existing places. id is a short lowercase slug such as "ji-penthouse". description is 30 to 60 words fixing the exterior and the main room: layout, materials, colours, light. Quote the novel, and pick one answer for anything it leaves out.
- memory: the story so far through the end of this batch, rewritten from the previous memory plus this batch. summary at most ${MAX_SUMMARY_WORDS} words. threads lists open questions and promises the story has not paid off yet, one short line each; drop the ones this batch resolves.
Never use em or en dashes.`

function userPrompt(
  adaptation: Adaptation,
  batch: readonly BatchChapter[],
  cast: readonly Character[],
  previous: MangaChapter | undefined,
  allowSkip: boolean,
  feedback: string,
): string {
  const castText = cast.length
    ? cast
        .map((c) => `${c.id}: ${c.name}, ${c.role}. Looks: ${c.looks.map((l) => `${l.id.slice(l.id.indexOf('@') + 1)} (${l.name}${l.change ? `: ${l.change}` : ''})`).join('; ')}${c.now ? `. Now: ${c.now}` : ''}`)
        .join('\n')
    : 'None yet.'
  const props = adaptation.props ?? []
  const propsText = props.length ? props.map((prop) => `${prop.id}: ${prop.name} (${prop.kind})`).join('\n') : 'None yet.'
  const places = adaptation.places ?? []
  const placesText = places.length ? places.map((place) => `${place.id}: ${place.name}`).join('\n') : 'None yet.'
  const memory = adaptation.memory
  const memoryText = memory
    ? `${memory.summary}\nOpen threads:\n${memory.threads.map((thread) => `- ${thread}`).join('\n') || 'none'}`
    : 'None yet: this batch starts the story.'
  const chapters = batch
    .map((chapter) => {
      const heading = `Novel chapter ${chapter.ref.index}: ${chapter.ref.name}`
      const part = chapter.part
      if (!part) return `${heading}\n${chapter.text}`
      const note = part.index < part.total
        ? 'The chapter continues in the next batch, so leave it out of chapters and skip.'
        : 'Its earlier parts are in the story so far.'
      return `${heading}, part ${part.index} of ${part.total}. ${note}\n${chapter.text}`
    })
    .join('\n\n')
  return `Novel: ${adaptation.title}.
${allowSkip ? 'This is the opening batch, so skipping a prologue is allowed.' : 'Skipping is not allowed: return "skip": [].'}
Story so far:
${memoryText}
Existing cast:
${castText}
Existing props:
${propsText}
Existing places:
${placesText}
Previous manga chapter: ${previous ? `${previous.number}. ${previous.title}: ${previous.summary}` : 'none'}

${chapters}${feedback}`
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string')
}

function fields(value: Record<string, unknown>, names: readonly string[]): boolean {
  return names.every((name) => typeof value[name] === 'string')
}

function planShape(value: unknown): value is PlanDraft {
  return record(value) &&
    Array.isArray(value.skip) && value.skip.every((index: unknown) => typeof index === 'number' && Number.isInteger(index)) &&
    Array.isArray(value.chapters) && value.chapters.every((chapter: unknown) => record(chapter) &&
      fields(chapter, ['title', 'summary']) && Array.isArray(chapter.novelChapters) &&
      chapter.novelChapters.every((index: unknown) => typeof index === 'number' && Number.isInteger(index)) &&
      (chapter.wearing === undefined || (record(chapter.wearing) && Object.values(chapter.wearing).every((look) => typeof look === 'string')))) &&
    Array.isArray(value.characters) && value.characters.every((character: unknown) => record(character) &&
      fields(character, ['id', 'name', 'role', 'appearance', 'now']) &&
      (character.looks === undefined || (Array.isArray(character.looks) && character.looks.every((look: unknown) => record(look) && fields(look, ['id', 'name', 'change']))))) &&
    Array.isArray(value.props) && value.props.every((prop: unknown) => record(prop) && fields(prop, ['id', 'name', 'kind', 'description'])) &&
    Array.isArray(value.places) && value.places.every((place: unknown) => record(place) && fields(place, ['id', 'name', 'description'])) &&
    record(value.memory) && typeof value.memory.summary === 'string' && strings(value.memory.threads)
}

export function validatePlan(draft: unknown, batch: readonly BatchChapter[], allowSkip: boolean, fast = false, cast: readonly Character[] = []): string[] {
  if (!planShape(draft)) return ['plan must contain valid skip, chapters, characters, looks, props, places and memory records']
  const errors: string[] = []
  const wanted = batch.filter((chapter) => !chapter.part || chapter.part.index === chapter.part.total).map((chapter) => chapter.ref.index)
  const skip = draft.skip ?? []
  if ((!allowSkip || fast) && skip.length) errors.push('skip must be [] for this batch')
  if (new Set(skip).size !== skip.length || skip.some((index) => !wanted.includes(index))) errors.push('skip contains duplicate or unknown novel chapters')
  const covered = (draft.chapters ?? []).flatMap((chapter) => chapter.novelChapters ?? [])
  const expected = wanted.filter((index) => !skip.includes(index))
  if (covered.join(',') !== expected.join(',')) {
    errors.push(`chapters must cover novel chapters ${expected.join(', ')} in order, each once; got ${covered.join(', ') || 'none'}`)
  }
  for (const chapter of draft.chapters ?? []) {
    if (!chapter.title?.trim()) errors.push('every chapter needs a title')
    if (!chapter.summary?.trim()) errors.push('every chapter needs a summary')
    if (!chapter.novelChapters?.length) errors.push('every manga chapter must cover a source chapter')
    if (fast && chapter.novelChapters?.length !== 1) errors.push('fast mode requires one source chapter per manga chapter')
    for (const [characterId, lookId] of Object.entries(chapter.wearing ?? {})) {
      const known = cast.find((character) => character.id === characterId)?.looks.some((look) => look.id === `${characterId}@${lookId}`)
      const drafted = draft.characters?.find((character) => character.id === characterId)
      const added = drafted && (lookId === 'main' || drafted.looks?.some((look) => look.id === lookId))
      if (!known && !added) errors.push(`chapter "${chapter.title}" wearing: "${characterId}" has no look "${lookId}"`)
    }
  }
  const ids = new Set<string>()
  for (const character of draft.characters ?? []) {
    const id = (character.id ?? '').normalize('NFKC')
    if (!id || slug(id) !== id || ids.has(id)) errors.push('character ids must be unique lowercase slugs')
    ids.add(id)
    if (!character.name?.trim()) errors.push('every character needs a name')
    if (!cast.some((known) => known.id === id) && !character.appearance?.trim()) errors.push(`new character ${id} needs an appearance`)
    const lookIds = new Set<string>()
    for (const look of character.looks ?? []) {
      const lookId = (look.id ?? '').normalize('NFKC')
      if (!lookId || slug(lookId) !== lookId || lookIds.has(lookId) || !look.name?.trim()) errors.push(`character ${id} has invalid or duplicate looks`)
      lookIds.add(lookId)
    }
  }
  for (const [label, entries, maximum] of [['props', draft.props ?? [], MAX_NEW_PROPS], ['places', draft.places ?? [], MAX_NEW_PLACES]] as const) {
    if (entries.length > maximum) errors.push(`${label} must contain at most ${maximum} entries`)
    const seen = new Set<string>()
    for (const entry of entries) {
      const id = (entry.id ?? '').normalize('NFKC')
      if (!id || slug(id) !== id || seen.has(id) || !entry.name?.trim() || !entry.description?.trim()) errors.push(`${label} contains incomplete or duplicate entries`)
      seen.add(id)
    }
  }
  for (const prop of draft.props ?? []) {
    if (!PROP_KINDS.some((kind) => kind === prop.kind)) errors.push(`prop ${prop.id} has an invalid kind`)
  }
  const summary = draft.memory?.summary?.trim()
  if (!summary) errors.push('memory.summary is required')
  else if (summary.split(/\s+/).length > MAX_SUMMARY_WORDS * 1.2) errors.push(`memory.summary is over ${MAX_SUMMARY_WORDS} words`)
  return errors
}

function mergeCharacters(
  adaptation: Adaptation,
  cast: readonly Character[],
  draft: PlanDraft,
  firstChapter: number,
): Character[] {
  const byId = new Map(cast.map((character) => [character.id, character]))
  const changed = new Map<string, Character>()

  for (const entry of draft.characters ?? []) {
    const id = slug(entry.id?.trim() || entry.name || '')
    if (!id) continue
    const existing = changed.get(id) ?? byId.get(id)
    const character: Character = existing
      ? { ...existing, looks: [...existing.looks] }
      : {
          id,
          adaptationId: adaptation.id,
          name: clean(entry.name ?? id),
          role: clean(entry.role ?? ''),
          appearance: clean(entry.appearance ?? ''),
          firstNovelChapter: firstChapter,
          looks: [],
        }
    if (entry.now?.trim()) character.now = clean(entry.now)

    for (const look of entry.looks ?? []) {
      const lookId = `${id}@${slug(look.id || look.name || 'main')}`
      if (character.looks.some((known) => known.id === lookId)) continue
      character.looks.push({
        id: lookId,
        name: clean(look.name || 'Main'),
        change: lookId.endsWith('@main') ? '' : clean(look.change ?? ''),
        sheetKey: null,
      })
    }
    if (!character.looks.some((look) => look.id.endsWith('@main'))) {
      character.looks.unshift({ id: `${id}@main`, name: 'Main', change: '', sheetKey: null })
    }
    changed.set(id, character)
  }

  return [...changed.values()]
}

function newProps(existing: readonly Prop[], draft: PlanDraft): Prop[] {
  const props: Prop[] = []
  for (const entry of draft.props ?? []) {
    if (props.length >= MAX_NEW_PROPS) break
    const id = slug(entry.id?.trim() || entry.name || '')
    const description = clean(entry.description ?? '')
    if (!id || !description || [...existing, ...props].some((prop) => prop.id === id)) continue
    const kind = PROP_KINDS.find((item) => item === entry.kind) ?? 'object'
    props.push({ id, name: clean(entry.name || id), kind, description })
  }
  return props
}

function newPlaces(existing: readonly Place[], draft: PlanDraft): Place[] {
  const places: Place[] = []
  for (const entry of draft.places ?? []) {
    if (places.length >= MAX_NEW_PLACES) break
    const id = slug(entry.id?.trim() || entry.name || '')
    const description = clean(entry.description ?? '')
    if (!id || !description || [...existing, ...places].some((place) => place.id === id)) continue
    places.push({ id, name: clean(entry.name || id), description })
  }
  return places
}

/** Cuts a chapter longer than one request at a line break, else a space, past the middle of each window. */
function textParts(text: string): string[] {
  const parts: string[] = []
  let from = 0
  while (text.length - from > MAX_PLAN_TEXT_CHARS) {
    const limit = from + MAX_PLAN_TEXT_CHARS
    const floor = from + MAX_PLAN_TEXT_CHARS / 2
    const line = text.lastIndexOf('\n', limit - 1)
    const space = text.lastIndexOf(' ', limit - 1)
    let cut = line >= floor ? line + 1 : space >= floor ? space + 1 : limit
    const code = text.charCodeAt(cut)
    if (code >= 0xdc00 && code <= 0xdfff) cut++
    parts.push(text.slice(from, cut))
    from = cut
  }
  parts.push(text.slice(from))
  return parts
}

/** Consecutive groups of at most `MAX_PLAN_TEXT_CHARS` of novel text, never truncating a chapter. */
function planGroups(batch: readonly BatchChapter[]): BatchChapter[][] {
  const groups: BatchChapter[][] = []
  let size = 0
  for (const chapter of batch) {
    const texts = textParts(chapter.text)
    const pieces = texts.length === 1 ? [chapter] : texts.map((text, index) => ({ ...chapter, text, part: { index: index + 1, total: texts.length } }))
    for (const piece of pieces) {
      const group = groups.at(-1)
      if (group && size + piece.text.length <= MAX_PLAN_TEXT_CHARS) {
        group.push(piece)
        size += piece.text.length
      } else {
        groups.push([piece])
        size = piece.text.length
      }
    }
  }
  return groups
}

export async function planBatch(
  settings: AdaptSettings,
  adaptation: Adaptation,
  batch: readonly BatchChapter[],
  cast: readonly Character[],
  previous: MangaChapter | undefined,
  plan: number,
  signal?: AbortSignal,
  options?: ChatOptions,
): Promise<Plan> {
  const allowSkip = settings.mode !== 'fast' && adaptation.readThrough === 0 && adaptation.skipPrologue
  const marked = settings.mode === 'fast' ? batch : batch.map((chapter) => {
    const parts = sourceSections(chapter.text).length
    return parts > 1 ? { ...chapter, mangaParts: parts } : chapter
  })
  const groups = planGroups(marked)
  if (groups.length < 2) return planGroup(settings, adaptation, marked, cast, previous, plan, allowSkip, signal, options)
  const plans: Plan[] = []
  const characters = new Map<string, Character>()
  let context = adaptation
  for (const group of groups) {
    const opening = allowSkip && plans.every((part) => !part.chapters.length && !part.skip.length)
    const known = [...cast.filter((character) => !characters.has(character.id)), ...characters.values()]
    const last = plans.flatMap((part) => part.chapters).at(-1) ?? previous
    const part = await planGroup(settings, context, group, known, last, plan, opening, signal, options)
    plans.push(part)
    for (const character of part.characters) characters.set(character.id, character)
    context = { ...context, memory: part.memory, props: [...(context.props ?? []), ...part.props], places: [...(context.places ?? []), ...part.places] }
  }
  return {
    skip: plans.flatMap((part) => part.skip),
    chapters: plans.flatMap((part) => part.chapters),
    characters: [...characters.values()],
    props: plans.flatMap((part) => part.props),
    places: plans.flatMap((part) => part.places),
    memory: plans.at(-1)!.memory,
  }
}

async function planGroup(
  settings: AdaptSettings,
  adaptation: Adaptation,
  batch: readonly BatchChapter[],
  cast: readonly Character[],
  previous: MangaChapter | undefined,
  plan: number,
  allowSkip: boolean,
  signal: AbortSignal | undefined,
  options: ChatOptions | undefined,
): Promise<Plan> {
  const stageSignal = createTextStageSignal(signal)
  const fast = settings.mode === 'fast'
  const validation = jsonValue({ adaptation, batch, cast, previous, plan, allowSkip, fast }) as JsonObject
  let feedback = ''
  let attempts = 0
  let retryReason: string | undefined
  const capture = captureValidation('plan', validation, options)
  const chatOptions: ChatOptions = { ...capture.options, onAttempt: (event) => {
    options?.onAttempt?.({ ...event, attempt: ++attempts, reason: event.reason ?? retryReason })
    retryReason = undefined
  } }
  for (let attempt = 1; attempt <= 2; attempt++) {
    let draft: unknown
    try {
      draft = await chatJson<unknown>(
        settings,
        settings.planningModel,
        SYSTEM,
        userPrompt(adaptation, batch, cast, previous, allowSkip, feedback) + (fast ? '\nFast mode: use exactly one source chapter per manga chapter. Do not split within a source chapter, combine chapters, skip story, or reduce storyboard page counts.' : ''),
        stageSignal,
        chatOptions,
      )
    } catch (error) {
      if (!(error instanceof MalformedReplyError) || attempt === 2) throw error
      retryReason = 'Repairing malformed plan JSON'
      feedback = `\n\n${malformedFeedback(error)}\nPrevious draft:\n${replyExcerpt(error.content)}`
      continue
    }
    const errors = validatePlan(draft, batch, allowSkip, fast, cast)
    if (errors.length) await capture.finish(errors, draft)
    if (errors.length || !planShape(draft)) {
      retryReason = 'Repairing chapter plan validation errors'
      feedback = `\n\nPrevious draft:\n${JSON.stringify(draft)}\nReturn a corrected full plan:\n${errors.join('\n')}`
      continue
    }

    const result = planFromDraft(draft, validation)
    await capture.success(draft, result)
    return result
  }
  throw new Error('The planner could not split these chapters. Retry, or switch the planning model in Settings.')
}

export function normalizePlanDraft(raw: unknown, context: JsonObject): Plan {
  const errors = validatePlan(raw, context.batch as unknown as BatchChapter[], context.allowSkip === true, context.fast === true, context.cast as unknown as Character[])
  if (errors.length || !planShape(raw)) throw new Error(errors.join('\n') || 'Invalid plan shape.')
  return planFromDraft(raw, context)
}

/** Each manga chapter one draft entry becomes: one per part of an oversized chapter, and runs cut before `MAX_CHAPTER_TEXT_CHARS`. */
function entryRuns(novelChapters: readonly number[], pieces: ReadonlyMap<number, BatchChapter>): NovelChapterRef[][] {
  const runs: NovelChapterRef[][] = []
  let run: NovelChapterRef[] = []
  let size = 0
  for (const index of novelChapters) {
    const piece = pieces.get(index)!
    const parts = piece.mangaParts ?? 1
    if (parts > 1 || (run.length && size + piece.text.length > MAX_CHAPTER_TEXT_CHARS)) {
      if (run.length) runs.push(run)
      run = []
      size = 0
    }
    if (parts > 1) {
      for (let part = 1; part <= parts; part++) runs.push([{ ...piece.ref, part: { index: part, total: parts } }])
      continue
    }
    run.push(piece.ref)
    size += piece.text.length
  }
  if (run.length) runs.push(run)
  return runs
}

function planFromDraft(draft: PlanDraft, context: JsonObject): Plan {
  const adaptation = context.adaptation as unknown as Adaptation
  const batch = context.batch as unknown as BatchChapter[]
  const cast = context.cast as unknown as Character[]
  const previous = context.previous as unknown as MangaChapter | undefined
  const plan = context.plan as number
  const contextMemory = adaptation.memory ? { ...adaptation.memory, threads: [...adaptation.memory.threads] } : null
  const pieces = new Map(batch.map((chapter) => [chapter.ref.index, chapter]))
  let number = (previous?.number ?? 0) + 1
  const chapters = (draft.chapters ?? []).flatMap((entry) => {
    const runs = entryRuns(entry.novelChapters ?? [], pieces)
    return runs.map((novelChapters, part): MangaChapter => {
      const current = number++
      const title = clean(entry.title ?? `Chapter ${current}`)
      return {
        id: chapterId(adaptation.id, current),
        adaptationId: adaptation.id,
        number: current,
        title: runs.length > 1 ? `${title}, part ${part + 1}` : title,
        summary: clean(entry.summary ?? ''),
        ...(Object.keys(entry.wearing ?? {}).length
          ? { wearing: Object.fromEntries(Object.entries(entry.wearing!).map(([characterId, lookId]) => [characterId, `${characterId}@${lookId}`])) }
          : {}),
        novelChapters,
        plan,
        contextMemory,
        status: 'queued',
        script: null,
        beats: null,
        cut: [],
        pageCount: 0,
        panelsDone: 0,
        panelsTotal: 0,
        redraw: [],
        drawnAt: null,
        error: null,
      }
    })
  })
  return {
    skip: draft.skip ?? [],
    chapters,
    characters: mergeCharacters(adaptation, cast, draft, batch[0]?.ref.index ?? 1),
    props: newProps(adaptation.props ?? [], draft),
    places: newPlaces(adaptation.places ?? [], draft),
    memory: {
      summary: clean(draft.memory?.summary ?? ''),
      threads: (draft.memory?.threads ?? []).map((thread) => clean(thread)).filter(Boolean),
      updatedThrough: batch.at(-1)?.ref.index ?? adaptation.readThrough,
    },
  }
}
