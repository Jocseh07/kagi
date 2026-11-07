import { captureValidation } from './journal/validation'
import type { ValidationCapture } from './journal/validation'
import type { JsonObject } from './journal/types'
import { accountDialogue, normalizeDialogue } from './beats'
import { MalformedReplyError, chatJson, createTextStageSignal, malformedFeedback, replyExcerpt } from './client'
import type { ChatOptions } from './client'
import { ALIGNS, FRAMES, GAPS, LAYOUTS, isFrame, isGap, isLayoutName } from './layouts'
import { PartFailedError, runParts } from './parts'
import type { PartProgress, Span } from './parts'
import { castLines, clean, decodeDialoguePunctuation, speakerCharacter } from './prompts'
import type { AdaptSettings } from './settings'
import type { AdaptStyle, Anchor, Beat, Character, Place, Prop, ScriptPage, ScriptPart, SpeakerAt, StoryMemory, TextItem } from './store'

const MIN_PAGES = 6
const MAX_PAGES = 16
/** Panels per page each beat weight earns: a key beat gets room for a set-up, the moment and a reaction. */
const KEY_PANELS = 3.75
const NORMAL_PANELS = 2.5
const TIERS_PANELS_PER_PAGE = 2.5
const STRIP_PANELS_PER_PAGE = 3
const MIN_KEY_PANELS = 2
/** A storyboard may run this many times its page target before it is sent back. */
const MAX_LENGTH_RATIO = 2
const MAX_CAPTION_WORDS = 14
const MAX_LINE_WORDS = 16
/** A cut beat line fits a caption as well as a bubble, since a line nobody says aloud is lettered as a caption. */
const BUBBLE_WORDS = Math.min(MAX_LINE_WORDS, MAX_CAPTION_WORDS)
const MIN_STRIP_PANELS = 2
const MAX_STRIP_PANELS = 4
/** Panels one storyboard request covers before the next part starts. */
const SECTION_PANELS = 10
const SPEAKER_AT: readonly SpeakerAt[] = ['left', 'center', 'right', 'off']

function quoted(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(', ')
}

const SHARED_RULES = `- beat: the index (from 0) of the beat this panel shows. Panels follow the beats in order, and every key beat gets at least one panel; a key beat usually gets two or three, with the biggest frame on its moment.
- place: a place id from the places list where the panel is set, or "" when none fits.
- camera: camera height and direction in a few words, e.g. "eye level from the doorway", "above the car looking down".
- looks: look ids from the cast list only, one for every recurring character visible in the panel. Extras need no id; describe them in prompt.
- props: prop ids from the props list only, one for every tracked vehicle, object or animal visible in the panel. List the one that matters most to the panel first. Use [] when none is visible.
- shot: e.g. "wide establishing", "medium two-shot", "close-up", "extreme close-up on eyes", "low angle".`

/** Every panel is drawn on its own; the place and camera fields carry the setting, so the prompt carries the action. */
const PROMPT_RULE = `- prompt: 40 to 80 words. Say where each character is in the place and what they touch (seat, steering wheel, door, floor, desk), then pose, expression, lighting and effects. Say what each hand holds, at most one object per hand, or that it is empty. Put each speaker on their speakerAt side of the frame. A vehicle has one steering wheel, in front of the driver only. Refer to characters, places and props by name and do not redescribe them. Never ask for text, logos or brand names in the image.`

export interface StoryboardTarget {
  pages: number
  panels: number
}

function beatPanels(beat: Beat): number {
  return beat.weight === 'key' ? KEY_PANELS : NORMAL_PANELS
}

function wantedPanels(beats: readonly Beat[]): number {
  return beats.reduce((sum, beat) => sum + beatPanels(beat), 0)
}

function panelsPerPage(style: AdaptStyle): number {
  return style === 'webtoon' ? STRIP_PANELS_PER_PAGE : TIERS_PANELS_PER_PAGE
}

/** Page count follows the beats instead of a fixed range, so a quiet chapter is short and a dense one gets room. */
export function storyboardTarget(beats: readonly Beat[], style: AdaptStyle): StoryboardTarget {
  const perPage = panelsPerPage(style)
  const wanted = wantedPanels(beats)
  const pages = Math.min(MAX_PAGES, Math.max(MIN_PAGES, Math.round(wanted / perPage)))
  return { pages, panels: Math.round(pages * perPage) }
}

/** Fewest panels a prompt-following draft uses for a beat: two for a key beat (the prompt asks for two or three), and enough two-item panels to letter every line in bubbles of at most `MAX_LINE_WORDS` words. */
function minBeatPanels(beat: Beat): number {
  const bubbles = beat.lines.reduce((sum, [, line]) => sum + Math.ceil(line.trim().split(/\s+/).length / MAX_LINE_WORDS), 0)
  return Math.max(beat.weight === 'key' ? MIN_KEY_PANELS : 0, Math.ceil(bubbles / 2))
}

const SENTENCE_END = /[.!?\u2026]["'\u2019\u201d)\]]*$/
const CLAUSE_END = /[,;:\u2014-]["'\u2019\u201d)\]]*$/

/** Cuts a line over `BUBBLE_WORDS` at the last sentence end, else clause mark, that fits; joined back with spaces the pieces are the line word for word. */
function bubbleLines(line: string): string[] {
  const words = line.trim().split(/\s+/)
  const pieces: string[] = []
  let from = 0
  while (words.length - from > BUBBLE_WORDS) {
    const fits = Array.from({ length: BUBBLE_WORDS - 3 }, (_, offset) => from + BUBBLE_WORDS - offset)
    const cut = fits.find((end) => SENTENCE_END.test(words[end - 1])) ?? fits.find((end) => CLAUSE_END.test(words[end - 1])) ?? from + BUBBLE_WORDS
    pieces.push(words.slice(from, cut).join(' '))
    from = cut
  }
  pieces.push(words.slice(from).join(' '))
  return pieces
}

/** The cast member a label like "The elder" means: the only one in the beat whose name holds every word of it. */
function castSpeaker(speaker: string, beat: Beat, characters: readonly Character[]): string {
  if (speakerCharacter(characters, speaker)) return speaker
  const words = normalizeDialogue(speaker).split(' ').filter((word) => word && word !== 'the')
  if (!words.length) return speaker
  const matches = characters.filter((character) => {
    const name = normalizeDialogue(character.name).split(' ')
    return beat.cast.includes(character.id) && words.every((word) => name.includes(word))
  })
  return matches.length === 1 ? matches[0].name : speaker
}

/** What the storyboard reads: each speaker as a cast name, and each line cut to one bubble or caption, so the model copying pieces never loses or rewords a word. */
function storyboardBeats(beats: readonly Beat[], characters: readonly Character[]): Beat[] {
  return beats.map((beat) => ({
    ...beat,
    lines: beat.lines.flatMap(([speaker, line]) => {
      const name = castSpeaker(speaker, beat, characters)
      return bubbleLines(line).map((piece): [string, string] => [name, piece])
    }),
  }))
}

/** Fewest pages that hold the panels validation demands, each page as full as its layout allows. */
function minPages(beats: readonly Beat[], style: AdaptStyle): number {
  const perPage = style === 'webtoon' ? MAX_STRIP_PANELS : Math.max(...Object.values(LAYOUTS).map((layout) => layout.length))
  return Math.ceil(beats.reduce((sum, beat) => sum + minBeatPanels(beat), 0) / perPage)
}

/** The target can sit below what validation demands, so the cap grows with the required panels instead of rejecting them. */
function storyboardPageLimit(beats: readonly Beat[], target: StoryboardTarget, style: AdaptStyle): number {
  return MAX_LENGTH_RATIO * Math.max(target.pages, minPages(beats, style))
}

/**
 * Runs of beats worth about `SECTION_PANELS` panels, closed early on a change of place. A chapter
 * whose beats want more than `MAX_PAGES` sections gets larger ones, so requests stay at most `MAX_PAGES`.
 */
function storyboardSections(beats: readonly Beat[]): Span[] {
  const budget = Math.max(SECTION_PANELS, wantedPanels(beats) / MAX_PAGES)
  const sections = (byPlace: boolean): Span[] => {
    const spans: Span[] = []
    let from = 0
    let panels = 0
    beats.forEach((beat, index) => {
      const newPlace = byPlace && index > from && beat.place !== beats[index - 1].place
      if (index > from && (panels >= budget || (newPlace && panels >= budget / 2))) {
        spans.push({ from, to: index })
        from = index
        panels = 0
      }
      panels += beatPanels(beat)
    })
    const last = spans.at(-1)
    if (last && panels < budget / 2) last.to = beats.length
    else spans.push({ from, to: beats.length })
    return spans
  }
  const spans = sections(true)
  return spans.length > MAX_PAGES ? sections(false) : spans
}

/** A section's share of the chapter's target, so splitting never changes the chapter's length. */
function sectionTarget(beats: readonly Beat[], span: Span, style: AdaptStyle): StoryboardTarget {
  const chapter = storyboardTarget(beats, style)
  const share = wantedPanels(beats.slice(span.from, span.to)) / (wantedPanels(beats) || 1)
  const pages = Math.max(1, Math.round(chapter.pages * share))
  return { pages, panels: Math.max(pages, Math.round(chapter.panels * share)) }
}

/** Rounds at cumulative shares, so the sections' limits add up to the chapter's instead of each rounding up past it. */
function sectionPageLimit(beats: readonly Beat[], span: Span, style: AdaptStyle): number {
  const chapter = storyboardPageLimit(beats, storyboardTarget(beats, style), style)
  const total = wantedPanels(beats) || 1
  const upTo = (index: number) => Math.round((chapter * wantedPanels(beats.slice(0, index))) / total)
  return Math.max(1, upTo(span.to) - upTo(span.from), MAX_LENGTH_RATIO * minPages(beats.slice(span.from, span.to), style))
}

function placeLines(places: readonly Place[]): string {
  return places.map((place) => `${place.id}: ${place.name}`).join('\n')
}

function propLines(props: readonly Prop[]): string {
  return props.map((prop) => `${prop.id}: ${prop.name} (${prop.kind})`).join('\n')
}

function textRules(characters: readonly Character[], props: readonly Prop[], places: readonly Place[], wearing: Readonly<Record<string, string>> | undefined): string {
  return `- text: 0 to 2 items {"kind": "speech"|"thought"|"caption"|"sfx", "speaker", "speakerAt", "line", "anchor": "tl"|"tr"|"bl"|"br"}; two items in one panel use different anchors. Use the beats' own lines, word for word. A beat line that nobody says aloud, such as a quoted name, title, technique or system message, goes in a caption or sfx instead, word for word. Captions are at most ${MAX_CAPTION_WORDS} words, and at least a third of all panels carry no narration caption of your own.
- line: every beat line is already at most ${BUBBLE_WORDS} words and is one bubble or caption as written. Never merge two beat lines into one item, never shorten one, and never cut required dialogue. Consecutive lines of one speaker stay in the same panel or run on into the next.
- speaker: required for speech and thought. The cast name of whoever says or thinks the line (the name after the look id, never the look id itself), also when the novel's narrator speaks as "I"; never "I", "me" or "narrator".
- speakerAt: required for speech and thought: ${quoted(SPEAKER_AT)}, where the speaker stands in this panel, or "off" for a voice from outside it. Put the anchor on the same side as the speaker.
- A line goes on a panel that shows its speaker: list the speaker's look in looks and describe them in prompt. Use "off" only when the speaker is deliberately unseen, such as a voice through a door or phone.
- Dialogue between two people: a two-shot to place them, then the speaker's close-up and the listener's reaction. A reaction panel carries only the listener's own words, or none. Keep each character on the same side of the frame for the whole scene.
- Show, don't narrate: turn exposition into images instead of caption boxes. Open each new place with an establishing panel.
Never use em or en dashes.
Cast:${wearing && Object.keys(wearing).length ? ' A character listed with only one look wears it for this whole chapter; use that look id for them in every panel.' : ''}
${castLines(characters, wearing) || 'No recurring characters.'}
Places:
${placeLines(places) || 'No tracked places.'}
Props:
${propLines(props) || 'No tracked props.'}`
}

function tiersSystem(target: StoryboardTarget, characters: readonly Character[], props: readonly Prop[], places: readonly Place[], wearing: Readonly<Record<string, string>> | undefined): string {
  return `You are a manga storyboard artist turning a chapter's beats into about ${target.pages} pages with about ${target.panels} panels in total.
Return only JSON: {"pages": [{"layout", "panels": [{"beat", "place", "camera", "shot", "looks", "props", "prompt", "text"}]}]}.
- layout: "tiers-2" (2 wide panels stacked) or "tiers-3" (3 wide panels stacked). The panel count must match the layout. Give a key beat's moment a "tiers-2" page.
${SHARED_RULES}
${PROMPT_RULE} Every panel is a wide landscape frame; keep the key action in the middle third.
${textRules(characters, props, places, wearing)}`
}

function stripSystem(target: StoryboardTarget, characters: readonly Character[], props: readonly Prop[], places: readonly Place[], wearing: Readonly<Record<string, string>> | undefined): string {
  return `You are a Korean webtoon storyboard artist turning a chapter's beats into a vertical scrolling strip: about ${target.pages} segments with about ${target.panels} panels in total. Keep every beat; do not compress beats to save panels.
Return only JSON: {"pages": [{"layout": "strip", "tone", "panels": [{"beat", "place", "camera", "frame", "gapAfter", "align", "shot", "looks", "props", "prompt", "text"}]}]}.
- Each segment has ${MIN_STRIP_PANELS} to ${MAX_STRIP_PANELS} panels, read top to bottom.
- tone: "light" (white gaps) for almost everything, fights and night scenes included. "dark" (near-black gaps) only for a scene set in total darkness, a flashback or a dream.
- frame: "wide" (full-width landscape, for establishing shots and action), "inset" (smaller landscape, for quiet beats and details), "close" (square, for faces and reactions) or "tall" (portrait, for full-body shots, height, falls and big reveals). A key beat's moment gets "wide" or "tall".
- gapAfter: the white space after the panel, by elapsed time: "tight" (the next moment, fast action), "normal", "pause" (a beat of silence, before a reaction) or "reveal" (a long held breath before a reveal or scene change).
- align: ${quoted(ALIGNS)}. Offset smaller frames toward the side their subject faces or speaks from.
${SHARED_RULES}
${PROMPT_RULE} Each image is drawn in its frame's own shape and shown whole.
${textRules(characters, props, places, wearing)}`
}

/** What the storyboard model reads instead of the raw chapter. */
function beatsText(beats: readonly Beat[], memory: StoryMemory | undefined, earlier: readonly Beat[], previousPage: ScriptPage | undefined): string {
  const lines = beats.map((beat, index) => {
    const said = beat.lines.map(([speaker, line]) => `  ${speaker}: "${decodeDialoguePunctuation(line)}"`).join('\n')
    return `${index}. [${beat.weight}] ${beat.moment}${beat.place ? ` (place: ${beat.place})` : ''}${beat.cast.length ? ` (cast: ${beat.cast.join(', ')})` : ''}${said ? `\n${said}` : ''}`
  })
  const before = earlier.length
    ? `\n\nEarlier in this chapter, already storyboarded:\n${earlier.map((beat) => `- ${beat.moment}`).join('\n')}`
    : ''
  const lastPage = previousPage
    ? `\n\nThe page before these beats. Continue from it and keep each character on the same side of the frame:\n${JSON.stringify({
      ...previousPage,
      panels: previousPage.panels.map(({ beat: _beat, check: _check, ...panel }) => panel),
    })}`
    : ''
  return `Story so far: ${memory?.summary ?? 'This chapter starts the story.'}${before}${lastPage}

Beats:
${lines.join('\n')}`
}

export interface StoryboardInput {
  beats: readonly Beat[]
  memory: StoryMemory | undefined
  characters: readonly Character[]
  props: readonly Prop[]
  places: readonly Place[]
  /** Character id to the look id they must wear in every panel of the chapter. */
  wearing?: Readonly<Record<string, string>>
  style: AdaptStyle
  note?: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string')
}

function choice(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === 'string' && allowed.includes(value)
}

function textShape(value: unknown): value is TextItem {
  return record(value) && choice(value.kind, ['speech', 'thought', 'caption', 'sfx']) &&
    typeof value.line === 'string' && value.line.trim().length > 0 &&
    choice(value.anchor, ['tl', 'tr', 'bl', 'br']) &&
    (value.speaker === undefined || typeof value.speaker === 'string') &&
    (value.speakerAt === undefined || choice(value.speakerAt, ['left', 'center', 'right', 'off']))
}

function pageShape(value: unknown): value is ScriptPage {
  return record(value) && choice(value.layout, ['tiers-2', 'tiers-3', 'strip']) &&
    (value.tone === undefined || value.tone === 'light' || value.tone === 'dark') &&
    Array.isArray(value.panels) && value.panels.every((panel: unknown) =>
      record(panel) && typeof panel.beat === 'number' &&
      typeof panel.shot === 'string' && panel.shot.trim().length > 0 &&
      typeof panel.prompt === 'string' && panel.prompt.trim().length > 0 &&
      (panel.place === undefined || typeof panel.place === 'string') &&
      (panel.camera === undefined || typeof panel.camera === 'string') &&
      strings(panel.looks) && (panel.props === undefined || strings(panel.props)) &&
      Array.isArray(panel.text) && panel.text.every(textShape) &&
      (panel.frame === undefined || isFrame(panel.frame)) &&
      (panel.gapAfter === undefined || choice(panel.gapAfter, Object.keys(GAPS))) &&
      (panel.align === undefined || choice(panel.align, ['left', 'center', 'right'])),
    )
}

function scriptShape(value: unknown): value is ScriptPage[] {
  return Array.isArray(value) && value.every(pageShape)
}

function dialogueErrors(pages: readonly ScriptPage[], input: Omit<StoryboardInput, 'memory' | 'note'>): string[] {
  const errors: string[] = []
  const panels = pages.flatMap((page) => page.panels)
  const speakerKey = (speaker: string) => normalizeDialogue(speakerCharacter(input.characters, speaker)?.name ?? speaker).replace(/^(the|a|an) /, '')
  input.beats.forEach((beat, beatIndex) => {
    const dialogue = panels.flatMap((panel, panelIndex) => panel.beat === beatIndex
      ? panel.text.filter((item) => item.kind === 'speech' || item.kind === 'thought').map((item) => ({ item, panelIndex }))
      : [])
    const lettered = panels.flatMap((panel) => panel.beat === beatIndex
      ? panel.text.filter((item) => item.kind === 'caption' || item.kind === 'sfx').map((item) => item.line)
      : [])
    const expectedSpeakers = new Set(beat.lines.map(([speaker]) => speakerKey(speaker)))
    const lineOrder = new Map<TextItem, number>()
    for (const { item } of dialogue) {
      if (!expectedSpeakers.has(speakerKey(item.speaker ?? ''))) errors.push(`beat ${beatIndex}: invented dialogue speaker "${item.speaker}"`)
    }
    for (const speaker of expectedSpeakers) {
      const expectedEntries = beat.lines.map(([name, line], index) => ({ name, line, index })).filter(({ name }) => speakerKey(name) === speaker)
      const expected = expectedEntries.map(({ line }) => line)
      const actual = dialogue.filter(({ item }) => speakerKey(item.speaker ?? '') === speaker)
      const accounting = accountDialogue(expected, actual.map(({ item }) => item.line))
      errors.push(...accounting.errors.map((error) => `beat ${beatIndex}: ${error}`))
      const missing = accounting.missing.filter((line) => accountDialogue([line], lettered).missing.length > 0)
      errors.push(...missing.map((line) => `beat ${beatIndex}: missing required dialogue "${line}"`))
      accounting.occurrences.forEach((occurrence, index) => {
        if (occurrence < 0) return
        lineOrder.set(actual[index].item, expectedEntries[occurrence].index)
        if (index === 0) return
        const previous = accounting.occurrences[index - 1]
        const step = actual[index].panelIndex - actual[index - 1].panelIndex
        if (occurrence === previous && step !== 0 && step !== 1) {
          errors.push(`beat ${beatIndex}: split dialogue must stay in one panel or run on into the next`)
        }
      })
    }
    let previousLine = -1
    for (const { item } of dialogue) {
      const current = lineOrder.get(item)
      if (current === undefined) continue
      if (current < previousLine) errors.push(`beat ${beatIndex}: dialogue out of order`)
      previousLine = current
    }
  })
  return [...new Set(errors)]
}

export function validateScript(pages: unknown, input: Omit<StoryboardInput, 'memory' | 'note'>): string[] {
  const target = storyboardTarget(input.beats, input.style)
  return validatePart(pages, input, target, storyboardPageLimit(input.beats, target, input.style))
}

function validatePart(pages: unknown, input: Omit<StoryboardInput, 'memory' | 'note'>, target: StoryboardTarget, limit: number): string[] {
  if (!Array.isArray(pages)) return ['"pages" must be an array']
  const shapeErrors = pages.flatMap((page: unknown, index) => pageShape(page) ? [] : [`page ${index + 1}: invalid page, panel, prompt, shot, reference array or text kind/anchor shape`])
  if (!scriptShape(pages)) return shapeErrors
  const { beats, characters, props, places, style, wearing } = input
  const errors: string[] = []
  const lookIds = new Set(characters.flatMap((character) => character.looks.map((look) => look.id)))
  const owners = new Map(characters.flatMap((character) => character.looks.map((look) => [look.id, character] as const)))
  const propIds = new Set(props.map((prop) => prop.id))
  const placeIds = new Set(places.map((place) => place.id))
  const panels = pages.flatMap((page: ScriptPage) => page.panels ?? [])
  if (!pages.length) errors.push('no pages')
  else if (pages.length > limit) {
    errors.push(`too long: ${pages.length} pages; use at most ${limit} pages and aim for ${target.pages}`)
  } else if (pages.length < target.pages / 2 || panels.length < target.panels / 2) {
    errors.push(`too short: ${pages.length} pages, ${panels.length} panels; aim for ${target.pages} pages and ${target.panels} panels`)
  }

  const shown = new Set<number>()
  let previousBeat = -1
  pages.forEach((page: ScriptPage, pageIndex) => {
    ;(page.panels ?? []).forEach((panel, panelIndex) => {
      const where = `page ${pageIndex + 1} panel ${panelIndex + 1}`
      if (!Number.isInteger(panel.beat) || panel.beat! < 0 || panel.beat! >= beats.length) {
        errors.push(`${where}: beat must be a beat index from 0 to ${beats.length - 1}`)
      } else {
        shown.add(panel.beat!)
        if (panel.beat! < previousBeat) errors.push('beats are out of order across the storyboard')
        previousBeat = panel.beat!
      }
      if (panel.place && !placeIds.has(panel.place)) errors.push(`${where}: unknown place "${panel.place}"`)
    })
  })
  beats.forEach((beat, index) => {
    if (beat.weight === 'key' && !shown.has(index)) errors.push(`key beat ${index} has no panel: ${beat.moment}`)
  })

  pages.forEach((page: ScriptPage, pageIndex) => {
    if (!isLayoutName(page.layout)) {
      errors.push(`page ${pageIndex + 1}: unknown layout "${String(page.layout)}"`)
      return
    }
    if ((page.layout === 'strip') !== (style === 'webtoon')) {
      errors.push(`page ${pageIndex + 1}: layout "${page.layout}" is not allowed here`)
      return
    }
    const count = (page.panels ?? []).length
    if (page.layout === 'strip') {
      if (count < MIN_STRIP_PANELS || count > MAX_STRIP_PANELS) {
        errors.push(`page ${pageIndex + 1}: a strip segment needs ${MIN_STRIP_PANELS} to ${MAX_STRIP_PANELS} panels, got ${count}`)
      }
      if (page.tone !== 'light' && page.tone !== 'dark') {
        errors.push(`page ${pageIndex + 1}: tone must be "light" or "dark"`)
      }
      ;(page.panels ?? []).forEach((panel, panelIndex) => {
        const where = `page ${pageIndex + 1} panel ${panelIndex + 1}`
        if (!isFrame(panel.frame)) errors.push(`${where}: frame must be one of ${quoted(FRAMES)}`)
        if (panel.gapAfter !== undefined && !isGap(panel.gapAfter)) {
          errors.push(`${where}: gapAfter must be one of ${quoted(Object.keys(GAPS))}`)
        }
        if (panel.align !== undefined && !ALIGNS.includes(panel.align)) {
          errors.push(`${where}: align must be one of ${quoted(ALIGNS)}`)
        }
      })
    } else if (count !== LAYOUTS[page.layout].length) {
      errors.push(`page ${pageIndex + 1}: "${page.layout}" needs ${LAYOUTS[page.layout].length} panels, got ${count}`)
    }
    ;(page.panels ?? []).forEach((panel, panelIndex) => {
      const where = `page ${pageIndex + 1} panel ${panelIndex + 1}`
      for (const id of panel.looks ?? []) {
        if (!lookIds.has(id)) {
          errors.push(`${where}: unknown look "${id}"`)
          continue
        }
        const owner = owners.get(id)!
        const worn = wearing?.[owner.id]
        if (worn && worn !== id) errors.push(`${where}: ${owner.name} wears look "${worn}" in this chapter, not "${id}"`)
      }
      for (const id of panel.props ?? []) if (!propIds.has(id)) errors.push(`${where}: unknown prop "${id}"`)
      const text = panel.text ?? []
      if (text.length > 2) errors.push(`${where}: ${text.length} text items, at most 2`)
      if (new Set(text.map((item) => item.anchor)).size < text.length) errors.push(`${where}: text items share an anchor`)
      for (const item of text) {
        if (item.kind === 'caption' && item.line.split(/\s+/).length > MAX_CAPTION_WORDS) {
          errors.push(`${where}: caption over ${MAX_CAPTION_WORDS} words`)
        }
        if (item.kind === 'speech' || item.kind === 'thought') {
          if (!item.speaker?.trim()) errors.push(`${where}: ${item.kind} needs a speaker`)
          if (!SPEAKER_AT.includes(item.speakerAt as SpeakerAt)) {
            errors.push(`${where}: ${item.kind} needs speakerAt, one of ${quoted(SPEAKER_AT)}`)
          }
          if (item.line.split(/\s+/).length > MAX_LINE_WORDS) {
            errors.push(`${where}: ${item.kind} over ${MAX_LINE_WORDS} words; split it across panels`)
          }
          const speaker = speakerCharacter(characters, item.speaker)
          if (item.speakerAt !== 'off' && speaker && !speaker.looks.some((look) => panel.looks?.includes(look.id))) {
            errors.push(`${where}: ${item.speaker} speaks but is not in looks; show them or use speakerAt "off"`)
          }
        }
      }
    })
  })

  const narrated = panels.filter((panel) => {
    const quoted = new Set(beats[panel.beat ?? -1]?.lines.map(([, line]) => normalizeDialogue(line)))
    return (panel.text ?? []).some((item) => item.kind === 'caption' && !quoted.has(normalizeDialogue(item.line)))
  }).length
  if (narrated > (panels.length * 2) / 3) errors.push(`${narrated} of ${panels.length} panels have narration captions, at most two thirds`)
  errors.push(...dialogueErrors(pages, input))
  return errors
}

/** Moves a bubble to its speaker's side of the panel, unless another item already holds that corner. */
function toSpeakerSide(text: TextItem[]): TextItem[] {
  const taken = new Set(text.map((item) => item.anchor))
  return text.map((item) => {
    if (item.speakerAt !== 'left' && item.speakerAt !== 'right') return item
    const wanted = `${item.anchor[0]}${item.speakerAt[0]}` as Anchor
    if (wanted === item.anchor || taken.has(wanted)) return item
    taken.delete(item.anchor)
    taken.add(wanted)
    return { ...item, anchor: wanted }
  })
}

/** A strip page is one segment of a vertical scroll, so an overfull one is cut into even segments of at most `MAX_STRIP_PANELS` in place; reading order stays the same. */
function splitStrips(pages: unknown): unknown {
  if (!Array.isArray(pages)) return pages
  return pages.flatMap((page: unknown) => {
    if (!record(page) || page.layout !== 'strip' || !Array.isArray(page.panels) || page.panels.length <= MAX_STRIP_PANELS) return [page]
    const panels: unknown[] = page.panels
    const count = Math.ceil(panels.length / MAX_STRIP_PANELS)
    return Array.from({ length: count }, (_, index) => ({
      ...page,
      panels: panels.slice(Math.round((index * panels.length) / count), Math.round(((index + 1) * panels.length) / count)),
    }))
  })
}

export interface ScriptOptions extends ChatOptions {
  parts?: readonly ScriptPart[]
  onSection?: (progress: PartProgress) => void
  onPart?: (part: ScriptPart, done: readonly ScriptPart[]) => void | Promise<void>
}

export async function writeScript(settings: AdaptSettings, written: StoryboardInput, signal?: AbortSignal, options?: ScriptOptions): Promise<ScriptPage[]> {
  const input = { ...written, beats: storyboardBeats(written.beats, written.characters) }
  const { beats, style } = input
  const write = async (span: Span, done: readonly ScriptPart[]): Promise<ScriptPart> => {
    const pages = await writeSection(settings, input, span, sectionTarget(beats, span, style), sectionPageLimit(beats, span, style), done.at(-1)?.pages.at(-1), signal, options)
    return {
      ...span,
      pages: pages.map((page) => ({ ...page, panels: page.panels.map((panel) => ({ ...panel, beat: (panel.beat ?? 0) + span.from })) })),
    }
  }
  const parts = await runParts(storyboardSections(beats), write, {
    saved: options?.parts,
    cut: (span) => (span.to - span.from > 1 ? span.from + Math.floor((span.to - span.from) / 2) : undefined),
    fail: (progress, error) => {
      const range = progress.to - progress.from === 1 ? `beat ${progress.from}` : `beats ${progress.from} to ${progress.to - 1}`
      return new Error(progress.total > 1
        ? `Storyboard part ${progress.index} of ${progress.total} (${range}) failed after 3 tries: ${groupErrors(error.errors)}. Retry continues from this part, or switch the script model in Settings.`
        : `Storyboard failed after 3 tries: ${groupErrors(error.errors)}. Retry, or switch the script model in Settings.`)
    },
    onSection: options?.onSection,
    onPart: options?.onPart,
  })
  return parts.flatMap((part) => part.pages)
}

/** Writes the pages for one section's beats, numbered from 0 within the section. */
async function writeSection(
  settings: AdaptSettings,
  input: StoryboardInput,
  span: Span,
  target: StoryboardTarget,
  limit: number,
  previousPage: ScriptPage | undefined,
  signal: AbortSignal | undefined,
  options: ChatOptions | undefined,
): Promise<ScriptPage[]> {
  const stageSignal = createTextStageSignal(signal)
  const { memory, characters, props, places, style, wearing } = input
  const beats = input.beats.slice(span.from, span.to)
  const sectionInput = { beats, characters, props, places, style, ...(wearing ? { wearing } : {}) }
  const system = (style === 'webtoon' ? stripSystem : tiersSystem)(target, characters, props, places, wearing)
  const brief = `${beatsText(beats, memory, input.beats.slice(0, span.from), previousPage)}${input.note?.trim() ? `\n\nThe reader asked for this rewrite: ${input.note.trim()}` : ''}`
  const models = [settings.scriptModel, settings.scriptModel, settings.planningModel]
  let feedback = ''
  let validationFeedback = ''
  let errors: string[] = []
  let previousPages: unknown[] | undefined
  let repairPages: number[] | undefined
  let attempts = 0
  let latest: ScriptPage[] | undefined
  let latestCapture: ValidationCapture | undefined
  let latestDraft: unknown
  let retryReason: string | undefined
  let overLong = false
  const chatOptions: ChatOptions = { ...options, onAttempt: (event) => {
    options?.onAttempt?.({ ...event, attempt: ++attempts, reason: event.reason ?? retryReason })
    retryReason = undefined
  } }
  for (const [index, model] of models.entries()) {
    const capture = captureValidation('script', { input: sectionInput, target, limit, span, previousPage, previousPages, repairPages }, chatOptions)
    let draft: unknown
    let pages: unknown
    try {
      draft = await chatJson<unknown>(settings, model, system, brief + feedback, stageSignal, capture.options)
    } catch (error) {
      if (!(error instanceof MalformedReplyError)) throw error
      errors = [`${model} returned broken JSON`]
      retryReason = 'Repairing malformed storyboard JSON'
      feedback = `${validationFeedback}\n\n${malformedFeedback(error)}\nPrevious invalid response:\n${replyExcerpt(error.content)}`
      continue
    }
    if (repairPages && previousPages) {
      const replacements = record(draft) ? draft.pages : undefined
      if (!Array.isArray(replacements) || replacements.length !== repairPages.length) {
        errors = ['repair must return exactly the requested pages in order']
        await capture.finish(errors, draft)
        retryReason = 'Repairing an incomplete page replacement'
        feedback = `${validationFeedback}\n\nPrevious invalid repair:\n${replyExcerpt(JSON.stringify(draft))}\n${errors[0]}`
        continue
      }
      const assembled = [...previousPages]
      repairPages.forEach((pageIndex, index) => { assembled[pageIndex] = replacements[index] })
      pages = assembled
    } else pages = record(draft) ? draft.pages : undefined
    pages = splitStrips(pages)
    errors = validatePart(pages, sectionInput, target, limit)
    if (!errors.length && scriptShape(pages)) {
      const finished = finishPages(pages, characters)
      await capture.success(draft, finished)
      return finished
    }
    await capture.finish(errors, draft)
    if (Array.isArray(pages) && pages.length > limit) {
      // Splitting would not help: a model that overruns keeps overrunning every smaller part.
      if (overLong || index === models.length - 1) throw new Error(`Storyboard ran to ${pages.length} pages, over the ${limit}-page limit. Retry, or switch the script model in Settings.`)
      overLong = true
    }
    if (scriptShape(pages)) {
      latest = pages
      latestDraft = draft
      latestCapture = capture
    }
    previousPages = Array.isArray(pages) ? pages : undefined
    const localPages = errors.map((error) => /^page (\d+)(?: panel \d+)?:/.exec(error)?.[1])
    repairPages = previousPages && localPages.every((page) => page !== undefined)
      ? [...new Set(localPages.map((page) => Number(page) - 1))].sort((a, b) => a - b)
      : undefined
    retryReason = repairPages ? 'Repairing invalid storyboard pages' : 'Repairing storyboard continuity or dialogue'
    validationFeedback = `\n\nPrevious full storyboard:\n${JSON.stringify({ pages })}\nValidation errors:\n${errors.join('\n')}\n${
      repairPages
        ? `Return {"pages": [...]} containing ONLY replacements for pages ${repairPages.map((index) => index + 1).join(', ')} in that order. Do not return or change other pages. Preserve all required dialogue and beat order.`
        : 'Return a corrected full storyboard, preserving all required dialogue and key beats.'
    }`
    feedback = validationFeedback
  }
  const lettered = latest && letterMissingLines(latest, errors)
  if (lettered && !validatePart(lettered, sectionInput, target, limit).length) {
    const finished = finishPages(lettered, characters)
    await latestCapture?.success(latestDraft, finished)
    return finished
  }
  throw new PartFailedError(errors.map((error) => error.replace(/\bbeat (\d+)\b/g, (_, index: string) => `beat ${Number(index) + span.from}`)))
}

const MISSING_LINE = /^beat (\d+): missing required dialogue "(.*)"$/

/** Last resort for a line every try left out, usually a quoted name nobody says aloud; only when nothing else is wrong. */
function letterMissingLines(pages: readonly ScriptPage[], errors: readonly string[]): ScriptPage[] | undefined {
  const missing = errors.map((error) => MISSING_LINE.exec(error))
  if (!missing.length || missing.some((match) => !match)) return undefined
  const next = structuredClone(pages) as ScriptPage[]
  const panels = next.flatMap((page) => page.panels)
  for (const match of missing) {
    const beat = Number(match![1])
    const panel = panels.find((item) => item.beat === beat && item.text.length < 2 && !item.text.some((text) => text.kind === 'caption'))
    const anchor = (['tl', 'tr', 'bl', 'br'] as const).find((corner) => !panel?.text.some((text) => text.anchor === corner))
    if (!panel || !anchor) return undefined
    panel.text = [{ kind: 'caption', line: match![2], anchor }, ...panel.text]
  }
  return next
}

function finishPages(pages: readonly ScriptPage[], characters: readonly Character[]): ScriptPage[] {
  return pages.map((page) => ({
    layout: page.layout,
    ...(page.layout === 'strip' ? { tone: page.tone } : {}),
    panels: page.panels.map((panel) => ({
      ...(page.layout === 'strip'
        ? { frame: panel.frame, gapAfter: panel.gapAfter ?? 'normal', align: panel.align ?? 'center' }
        : {}),
      beat: panel.beat,
      ...(panel.place ? { place: panel.place } : {}),
      ...(panel.camera?.trim() ? { camera: clean(panel.camera) } : {}),
      shot: clean(panel.shot ?? ''),
      looks: panel.looks ?? [],
      props: panel.props ?? [],
      prompt: clean(panel.prompt ?? ''),
      text: toSpeakerSide(
        (panel.text ?? []).map((item) => ({
          ...item,
          line: clean(decodeDialoguePunctuation(item.line)),
          ...(item.speaker ? { speaker: speakerCharacter(characters, item.speaker)?.name ?? item.speaker.trim() } : {}),
        })),
      ),
    })),
  }))
}

function groupErrors(errors: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const error of errors) {
    const rule = error.replace(/^page \d+( panel \d+)?: /, '').split(';')[0].trim()
    counts.set(rule, (counts.get(rule) ?? 0) + 1)
  }
  const groups = [...counts].map(([rule, count]) => (count > 1 ? `${rule} (${count}×)` : rule))
  const more = groups.length > 3 ? `, and ${groups.length - 3} more` : ''
  return `${groups.slice(0, 3).join(', ')}${more}`
}

export function normalizeScriptDraft(raw: unknown, context: JsonObject): ScriptPage[] {
  const input = context.input as unknown as Omit<StoryboardInput, 'memory' | 'note'>
  const target = context.target as unknown as StoryboardTarget
  // Runs saved before the page cap carry no limit; their section beats give the closest one.
  const limit = typeof context.limit === 'number' ? context.limit : storyboardPageLimit(input.beats, target, input.style)
  let pages: unknown = record(raw) ? raw.pages : undefined
  if (Array.isArray(context.repairPages) && Array.isArray(context.previousPages)) {
    if (!Array.isArray(pages) || pages.length !== context.repairPages.length) throw new Error('repair must return exactly the requested pages in order')
    const replacements = pages
    const assembled: unknown[] = [...context.previousPages]
    context.repairPages.forEach((index, offset) => {
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= assembled.length) throw new Error('Invalid repair page index.')
      assembled[index] = replacements[offset]
    })
    pages = assembled
  }
  pages = splitStrips(pages)
  let errors = validatePart(pages, input, target, limit)
  if (errors.length && scriptShape(pages)) {
    const lettered = letterMissingLines(pages, errors)
    if (lettered) {
      pages = lettered
      errors = validatePart(pages, input, target, limit)
    }
  }
  if (errors.length || !scriptShape(pages)) throw new Error(errors.join('\n') || 'Invalid storyboard shape.')
  return finishPages(pages, input.characters)
}
