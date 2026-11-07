import { captureValidation } from './journal/validation'
import { jsonValue } from './journal/runtime'
import type { JsonObject } from './journal/types'
import { MalformedReplyError, chatJson, createTextStageSignal, malformedFeedback, replyExcerpt } from './client'
import type { ChatOptions } from './client'
import { PartFailedError, runParts } from './parts'
import type { PartProgress, Span } from './parts'
import { clean, decodeDialoguePunctuation } from './prompts'
import type { AdaptSettings } from './settings'
import type { Beat, BeatPart, Character, Place, StoryMemory } from './store'

const PASSAGE_CHARS = 6000
const MIN_PASSAGE_CHARS = 1500
/** Context from earlier passages, newest beats first, so prompts stay flat on a long chapter. */
const MAX_EARLIER_CHARS = 6000
/** Far past what one passage needs; a longer list is a runaway reply. */
const MAX_PASSAGE_BEATS = 200
/** Text before the cursor that ends a paragraph glued to the next one: a lowercase word, digit or bracket, then sentence punctuation. */
const GLUED_END = /[\p{Ll}\p{N})][.!?…]+$/u
const GLUED_START = /[\p{Lu}"“-]/u
const BLANK_LINE = /\n[^\S\n]*\n/y
const PARAGRAPH_BREAK = /\n[^\S\n]*\n\s*/g
const SENTENCE_END = /[.!?…]+["'”’)\]]*\s+|[。！？]+[」』”’）]*/g

interface BeatsDraft {
  beats: Beat[]
  cut: string[]
}

export interface ChapterBeats {
  beats: Beat[]
  cut: string[]
}

const SYSTEM = `You break web novel chapters into the beats a comic adaptation must show, in reading order.
Return only JSON: {"beats": [{"moment": string, "weight": "key"|"normal", "place": string, "cast": string[], "lines": [[speaker, line]]}], "cut": string[]}.
- moment: one sentence on what happens and why it matters to the reader.
- weight: "key" for a decision, reveal, turn, fight blow or emotional peak the reader must see; "normal" for the rest. Every chapter has at least one key beat.
- place: a place id from the places list, or "" when none fits.
- cast: character ids from the cast list who are on screen.
- lines: the dialogue spoken or thought in this beat as [speaker name, line], copied word for word from the novel's quotes.
- cut: every quoted line from the novel you leave out of all beats, word for word. Leave out only filler; never a line that changes what the reader knows. A quoted name, title or term that nobody says aloud (a nickname, a technique, a book) is not dialogue: put it in cut and use it in moment.
Every quoted line of the novel appears exactly once: in some beat's lines or in cut.
Never use em or en dashes.`

function earlierText(earlier: readonly Beat[]): string {
  if (!earlier.length) return ''
  const lines: string[] = []
  let chars = 0
  for (let index = earlier.length - 1; index >= 0; index--) {
    const line = `- ${earlier[index].moment}`
    chars += line.length + 1
    if (chars > MAX_EARLIER_CHARS && lines.length) break
    lines.unshift(line)
  }
  return `Beats already written for the chapter's earlier text, for context only:
${lines.join('\n')}

Break only the novel text below into beats.

`
}

function userPrompt(text: string, memory: StoryMemory | undefined, characters: readonly Character[], places: readonly Place[], earlier: readonly Beat[], feedback: string): string {
  const placeText = places.map((place) => `${place.id}: ${place.name}`).join('\n') || 'No tracked places.'
  return `Story so far: ${memory?.summary ?? 'This chapter starts the story.'}
Cast:
${characters.map((character) => `${character.id}: ${character.name}. ${character.appearance}`).join('\n') || 'No recurring characters.'}
Places:
${placeText}

${earlierText(earlier)}${text}${feedback}`
}

/** Index of the first entry of the ascending `values` at or past `at`. */
function firstFrom(values: readonly number[], at: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (values[middle] < at) low = middle + 1
    else high = middle
  }
  return low
}

/** A cut about `MIN_PASSAGE_CHARS` past `from`, moved to the next space and out of any quote, or `undefined` before `limit`. */
function hardCut(text: string, from: number, limit: number, quoteEnd: (at: number) => number): number | undefined {
  let cut = quoteEnd(from + MIN_PASSAGE_CHARS)
  const space = text.slice(cut, cut + 200).search(/\s/)
  if (space >= 0) cut = quoteEnd(cut + space + 1)
  const code = text.charCodeAt(cut)
  if (code >= 0xdc00 && code <= 0xdfff) cut++
  return cut < limit ? cut : undefined
}

/** Sentence ends, then hard cuts, for a stretch with no paragraph break for a whole passage. */
function stretchBreaks(text: string, from: number, to: number, quoteEnd: (at: number) => number): number[] {
  const breaks: number[] = []
  let last = from
  const ends = [...text.slice(from, to).matchAll(SENTENCE_END)].map((match) => from + match.index + match[0].length)
  for (const at of [...ends.filter((end) => end < to && quoteEnd(end) === end), to]) {
    while (at - last > PASSAGE_CHARS) {
      const cut = hardCut(text, last, at, quoteEnd)
      if (cut === undefined) break
      breaks.push(cut)
      last = cut
    }
    if (at < to) breaks.push(at)
    last = at
  }
  return breaks
}

interface QuoteSpan extends Span {
  line: string
}

/**
 * Quotes in reading order. A quote never runs past its paragraph: many translations open speech that goes on into the
 * next paragraph and close it only there, and pairing marks across that swaps every later quote with the narration.
 * Text saved before paragraph breaks were kept reads `Riya!-"I knew`; a sentence end with no space before a capital,
 * quote mark or dash is taken as a paragraph edge, but only for a quote that opened a paragraph.
 */
function quoteSpans(text: string): QuoteSpan[] {
  const spans: QuoteSpan[] = []
  let start = -1
  let opensParagraph = false
  let paragraph = 0
  const close = (to: number, end: number) => {
    spans.push({ from: start, to, line: text.slice(start + 1, end) })
    start = -1
  }
  for (let at = 0; at < text.length; at++) {
    const char = text[at]
    BLANK_LINE.lastIndex = at
    if (char === '\n' && BLANK_LINE.test(text)) {
      if (start >= 0) close(at, at)
      at = BLANK_LINE.lastIndex - 1
      paragraph = at + 1
      continue
    }
    if (at > 0 && GLUED_START.test(char) && GLUED_END.test(text.slice(Math.max(0, at - 8), at))) {
      if (start >= 0 && (char === '"' || char === '”')) {
        close(at + 1, at)
        paragraph = at + 1
        continue
      }
      if (start >= 0 && opensParagraph) close(at, at)
      paragraph = at
    }
    if (char === '“' || (char === '"' && start < 0)) {
      if (start >= 0) close(at, at)
      start = at
      opensParagraph = /^[\s\-–—]*$/.test(text.slice(paragraph, at))
    } else if ((char === '”' || char === '"') && start >= 0) close(at + 1, at)
  }
  if (start >= 0) close(text.length, text.length)
  return spans
}

/** Break points outside every quote, so each quoted line falls in exactly one passage. */
function safeBreaks(text: string): number[] {
  const spans = quoteSpans(text)
  const starts = spans.map((span) => span.from)
  const ends = spans.map((span) => span.to)
  const quoteEnd = (at: number) => {
    const index = firstFrom(starts, at) - 1
    return index >= 0 && at < ends[index] ? ends[index] : at
  }
  const breaks: number[] = []
  let from = 0
  for (const at of [...[...text.matchAll(PARAGRAPH_BREAK)].map((match) => match.index + match[0].length), text.length]) {
    if (at <= 0 || (at < text.length && quoteEnd(at) !== at)) continue
    if (at - from > PASSAGE_CHARS) breaks.push(...stretchBreaks(text, from, at, quoteEnd))
    if (at < text.length) breaks.push(at)
    from = at
  }
  return breaks
}

function beatPassages(text: string, breaks: readonly number[]): Span[] {
  const spans: Span[] = []
  let from = 0
  for (const at of breaks) {
    if (at - from < PASSAGE_CHARS) continue
    spans.push({ from, to: at })
    from = at
  }
  const last = spans.at(-1)
  if (last && text.length - from < PASSAGE_CHARS / 3) last.to = text.length
  else spans.push({ from, to: text.length })
  return spans
}

function passageCut(breaks: readonly number[], span: Span): number | undefined {
  if (span.to - span.from < MIN_PASSAGE_CHARS) return undefined
  const middle = (span.from + span.to) / 2
  let best: number | undefined
  for (let index = firstFrom(breaks, span.from + 1); index < breaks.length && breaks[index] < span.to; index++) {
    if (best === undefined || Math.abs(breaks[index] - middle) < Math.abs(best - middle)) best = breaks[index]
  }
  return best
}

/** About even spans of at most about `maxChars`, cut only where a beat passage may end, so no quote is split. */
export function textSections(text: string, maxChars: number): Span[] {
  const count = Math.ceil(text.length / maxChars)
  if (count < 2) return [{ from: 0, to: text.length }]
  const breaks = safeBreaks(text)
  const sections: Span[] = []
  let from = 0
  for (let index = 1; index < count; index++) {
    const ideal = (text.length * index) / count
    const after = firstFrom(breaks, ideal)
    const near = [breaks[after - 1], breaks[after]].filter((at) => at !== undefined && at > from && at < text.length)
    if (!near.length) continue
    const cut = near.reduce((best, at) => (Math.abs(at - ideal) < Math.abs(best - ideal) ? at : best))
    sections.push({ from, to: cut })
    from = cut
  }
  sections.push({ from, to: text.length })
  return sections
}

export function normalizeDialogue(value: string): string {
  return decodeDialoguePunctuation(value).normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

export function quotedLines(text: string): string[] {
  return quoteSpans(text).map((span) => span.line.trim()).filter((line) => normalizeDialogue(line).length > 0)
}

/**
 * Matches each actual line, or a run of lines splitting one quote, to the first unused quote it spells out word for word.
 * `cut` entries that name no unused quote, such as a single-quoted technique the prompt asks to cut, account for nothing and are left out of `matchedCut`.
 */
export function accountDialogue(expected: readonly string[], actual: readonly string[], cut: readonly string[] = []): { missing: string[]; errors: string[]; occurrences: number[]; matchedCut: string[] } {
  const source = expected.map(normalizeDialogue)
  const sourceWords = source.map((line) => line.split(' '))
  const words = actual.map((line) => normalizeDialogue(line).split(' ').filter(Boolean))
  const byFirstWord = new Map<string, number[]>()
  const byLine = new Map<string, number[]>()
  source.forEach((line, index) => {
    for (const [map, key] of [[byFirstWord, sourceWords[index][0]], [byLine, line]] as const) {
      const list = map.get(key)
      if (list) list.push(index)
      else map.set(key, [index])
    }
  })
  const matchEnd = (index: number, position: number): number => {
    const target = sourceWords[index]
    let offset = 0
    for (let next = position; next < words.length && words[next].length; next++) {
      const tokens = words[next]
      if (offset + tokens.length > target.length || tokens.some((token, at) => token !== target[offset + at])) return -1
      offset += tokens.length
      if (offset === target.length) return next
    }
    return -1
  }
  const used = new Set<number>()
  const errors: string[] = []
  const occurrences: number[] = []
  for (let position = 0; position < words.length;) {
    let found = -1
    let end = position
    for (const index of byFirstWord.get(words[position][0] ?? '') ?? []) {
      if (used.has(index) || !words[position].length) continue
      end = matchEnd(index, position)
      if (end >= 0) {
        found = index
        break
      }
    }
    if (found < 0) {
      occurrences.push(-1)
      errors.push(`invented, duplicated, or incomplete dialogue: "${actual[position]}"`)
      position++
      continue
    }
    used.add(found)
    while (position <= end) {
      occurrences.push(found)
      position++
    }
  }
  const matchedCut: string[] = []
  for (const line of cut) {
    const queue = byLine.get(normalizeDialogue(line))
    while (queue?.length && used.has(queue[0])) queue.shift()
    const index = queue?.shift()
    if (index === undefined) continue
    used.add(index)
    matchedCut.push(line)
  }
  return { missing: expected.filter((_, index) => !used.has(index)), errors, occurrences, matchedCut }
}

export function missingLines(text: string, beats: readonly Beat[], cut: readonly string[]): string[] {
  return accountDialogue(quotedLines(text), beats.flatMap((beat) => beat.lines.map(([, line]) => line)), cut).missing
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function beatsShape(draft: unknown): draft is BeatsDraft {
  return record(draft) && Array.isArray(draft.beats) && draft.beats.every((beat: unknown) =>
    record(beat) && typeof beat.moment === 'string' && (beat.weight === 'key' || beat.weight === 'normal') &&
    (beat.place === undefined || typeof beat.place === 'string') &&
    Array.isArray(beat.cast) && beat.cast.every((id: unknown) => typeof id === 'string') &&
    Array.isArray(beat.lines) && beat.lines.every((line: unknown) =>
      Array.isArray(line) && line.length === 2 && line.every((part: unknown) => typeof part === 'string' && part.trim().length > 0),
    ),
  ) && Array.isArray(draft.cut) && draft.cut.every((line: unknown) => typeof line === 'string' && line.trim().length > 0)
}

/** `requireKey` is off for a passage that is not the chapter's last, or follows a key beat already written. */
export function validateBeats(draft: unknown, text: string, characters?: readonly Character[], requireKey = true): string[] {
  if (!beatsShape(draft)) return ['beats must contain valid moment, weight, place, cast and [speaker, line] records, with a string cut array']
  if (!draft.beats.length) return ['"beats" must be a non-empty array']
  if (draft.beats.length > MAX_PASSAGE_BEATS) return [`"beats" has ${draft.beats.length} entries; one passage needs at most ${MAX_PASSAGE_BEATS}`]
  const errors: string[] = []
  const characterIds = characters && new Set(characters.map((character) => character.id))
  if (requireKey && !draft.beats.some((beat) => beat.weight === 'key')) errors.push('at least one beat must have weight "key"')
  draft.beats.forEach((beat, index) => {
    if (!beat.moment.trim()) errors.push(`beat ${index + 1}: moment is required`)
    for (const id of beat.cast) if (characterIds && !characterIds.has(id)) errors.push(`beat ${index + 1}: unknown character "${id}"`)
  })
  const kept = draft.beats.flatMap((beat) => beat.lines.map(([, line]) => line))
  const accounting = accountDialogue(quotedLines(text), kept, draft.cut)
  // Translations often print a thought as a bare paragraph; a line the novel has word for word is not invented.
  const prose = ` ${normalizeDialogue(text)} `
  const unmatched = accounting.occurrences.flatMap((occurrence, position) => (occurrence < 0 ? [kept[position]] : []))
  const invented = accounting.errors.filter((_, index) => !prose.includes(` ${normalizeDialogue(unmatched[index])} `))
  errors.push(...invented, ...accounting.missing.map((line) => `line not kept or cut: "${line}"`))
  const order = accounting.occurrences.slice(0, kept.length)
  if (order.some((index, position) => position > 0 && index >= 0 && index < order[position - 1])) errors.push('beats contain dialogue out of source order')
  return errors
}

export interface BeatOptions extends ChatOptions {
  parts?: readonly BeatPart[]
  onSection?: (progress: PartProgress) => void
  onPart?: (part: BeatPart, done: readonly BeatPart[]) => void | Promise<void>
}

export async function writeBeats(
  settings: AdaptSettings,
  text: string,
  memory: StoryMemory | undefined,
  characters: readonly Character[],
  places: readonly Place[],
  signal?: AbortSignal,
  options?: BeatOptions,
): Promise<ChapterBeats> {
  const breaks = safeBreaks(text)
  const write = async (span: Span, done: readonly BeatPart[]): Promise<BeatPart> => {
    const earlier = done.flatMap((part) => part.beats)
    const requireKey = span.to === text.length && !earlier.some((beat) => beat.weight === 'key')
    const partOptions = { ...options, context: { ...options?.context, stage: 'beats' as const, validation: jsonValue({ span }) } }
    return { ...span, ...(await writeBeatPart(settings, text.slice(span.from, span.to), memory, characters, places, earlier, requireKey, signal, partOptions)) }
  }
  const parts = await runParts(beatPassages(text, breaks), write, {
    saved: options?.parts,
    cut: (span) => passageCut(breaks, span),
    fail: (progress, error) => {
      const shown = error.errors.slice(0, 3).join('; ')
      return new Error(progress.total > 1
        ? `Beats for part ${progress.index} of ${progress.total} failed after 3 tries: ${shown}. Retry continues from this part, or switch the script model in Settings.`
        : `The script model could not break this chapter into beats: ${shown}. Retry, or switch the script model in Settings.`)
    },
    onSection: options?.onSection,
    onPart: options?.onPart,
  })
  return { beats: parts.flatMap((part) => part.beats), cut: parts.flatMap((part) => part.cut) }
}

async function writeBeatPart(
  settings: AdaptSettings,
  text: string,
  memory: StoryMemory | undefined,
  characters: readonly Character[],
  places: readonly Place[],
  earlier: readonly Beat[],
  requireKey: boolean,
  signal: AbortSignal | undefined,
  options: ChatOptions | undefined,
): Promise<ChapterBeats> {
  const stageSignal = createTextStageSignal(signal)
  const models = [settings.scriptModel, settings.scriptModel, settings.planningModel]
  let feedback = ''
  let errors: string[] = []
  let attempts = 0
  let retryReason: string | undefined
  const inherited = options?.context?.validation
  const validation = jsonValue({ ...(inherited && typeof inherited === 'object' ? inherited : {}), text, memory, characters, places, earlier, requireKey }) as JsonObject
  const capture = captureValidation('beats', validation, options)
  const chatOptions: ChatOptions = { ...capture.options, onAttempt: (event) => {
    options?.onAttempt?.({ ...event, attempt: ++attempts, reason: event.reason ?? retryReason })
    retryReason = undefined
  } }
  for (const model of models) {
    let draft: unknown
    try {
      draft = await chatJson<unknown>(settings, model, SYSTEM, userPrompt(text, memory, characters, places, earlier, feedback), stageSignal, chatOptions)
    } catch (error) {
      if (!(error instanceof MalformedReplyError)) throw error
      errors = ['malformed JSON']
      retryReason = 'Repairing malformed beat JSON'
      feedback = `\n\n${malformedFeedback(error)}\nPrevious draft:\n${replyExcerpt(error.content)}`
      continue
    }
    errors = validateBeats(draft, text, characters, requireKey)
    if (!errors.length && beatsShape(draft)) {
      const result = chapterBeats(draft, text, places)
      await capture.success(draft, result)
      return result
    }
    await capture.finish(errors, draft)
    retryReason = 'Repairing beat validation errors'
    feedback = `\n\nPrevious draft:\n${replyExcerpt(JSON.stringify(draft))}\nReturn corrected full beats:\n${errors.join('\n')}`
  }
  throw new PartFailedError(errors.length ? errors : ['no usable reply'])
}

export function normalizeBeatDraft(raw: unknown, context: JsonObject): ChapterBeats {
  const errors = validateBeats(raw, context.text as string, context.characters as unknown as Character[], context.requireKey !== false)
  if (errors.length || !beatsShape(raw)) throw new Error(errors.join('\n') || 'Invalid beat shape.')
  return chapterBeats(raw, context.text as string, context.places as unknown as Place[])
}

/** The place a beat means: its own id, else the only known place whose id words all appear in it ("sky-fortune-city-fair" is "sky-fortune-fair"), else none. */
function knownPlace(id: string | undefined, places: readonly Place[]): string | undefined {
  if (!id || places.some((place) => place.id === id)) return id
  const words = new Set(id.split('-'))
  const matches = places.filter((place) => place.id.split('-').every((word) => words.has(word)))
  return matches.length === 1 ? matches[0].id : ''
}

function chapterBeats(draft: BeatsDraft, text: string, places: readonly Place[]): ChapterBeats {
  const kept = draft.beats.flatMap((beat) => beat.lines.map(([, line]) => line))
  return {
    beats: draft.beats.map((beat) => ({ ...beat, place: knownPlace(beat.place, places), moment: clean(beat.moment), lines: beat.lines.map(([speaker, line]): [string, string] => [speaker.trim(), decodeDialoguePunctuation(line).trim()]) })),
    cut: accountDialogue(quotedLines(text), kept, draft.cut).matchedCut.map((line) => decodeDialoguePunctuation(line).trim()),
  }
}
