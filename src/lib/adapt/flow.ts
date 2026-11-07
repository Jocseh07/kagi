import type { AdaptActivity } from './pipeline'
import { isMainLook } from './prompts'
import type { Adaptation, Character, MangaChapter, PanelCheck, TextItem } from './store'

export function novelRange(chapter: MangaChapter): string {
  const numbers = chapter.novelChapters.map((ref) => ref.index)
  if (!numbers.length) return ''
  const low = Math.min(...numbers)
  const high = Math.max(...numbers)
  return low === high ? String(low) : `${low}-${high}`
}

/** Highest novel chapter covered by the unbroken run of drawn chapters from the start. */
export function drawnThrough(chapters: readonly MangaChapter[]): number {
  let through = 0
  for (const chapter of [...chapters].sort((a, b) => a.number - b.number)) {
    if (chapter.status !== 'drawn') break
    for (const ref of chapter.novelChapters) through = Math.max(through, ref.part && ref.part.index < ref.part.total ? ref.index - 1 : ref.index)
  }
  return through
}

export function pastStop(adaptation: Adaptation, chapter: MangaChapter): boolean {
  if (adaptation.stopAt === undefined || !chapter.novelChapters.length) return false
  return Math.min(...chapter.novelChapters.map((ref) => ref.index)) > adaptation.stopAt
}

/** The novel chapter planning stops at: the stop point, or the end of the novel. */
export function planLimit(adaptation: Adaptation): number {
  return Math.min(adaptation.novelChapterCount, adaptation.stopAt ?? Infinity)
}

/** All caught up to a stop point that is short of the novel's end. */
export function waitsAtStopPoint(adaptation: Adaptation, chapters: readonly MangaChapter[]): boolean {
  return (
    adaptation.stopAt !== undefined &&
    adaptation.stopAt < adaptation.novelChapterCount &&
    caughtUp(adaptation, chapters)
  )
}

export function caughtUp(adaptation: Adaptation, chapters: readonly MangaChapter[]): boolean {
  return (
    adaptation.readThrough >= planLimit(adaptation) &&
    chapters.every(
      (chapter) => (chapter.status === 'drawn' || pastStop(adaptation, chapter)) && chapter.redraw.length === 0,
    )
  )
}

/** Every novel chapter read so far had no text, so nothing was planned. */
export function hasNoText(adaptation: Adaptation, chapters: readonly MangaChapter[]): boolean {
  return chapters.length === 0 && adaptation.readThrough > 0 && (adaptation.empty?.length ?? 0) >= adaptation.readThrough
}

export type StopMode = 'end' | 'next' | 'until'

export interface StopChoice {
  mode: StopMode
  count: string
}

export function stopChoiceFor(stopAt: number | undefined, base: number): StopChoice {
  return stopAt === undefined ? { mode: 'end', count: '10' } : { mode: 'until', count: String(Math.max(stopAt, base + 1)) }
}

/** The novel chapter to stop at, `undefined` for the end, or `null` when the input is not usable. */
export function resolveStop(choice: StopChoice, base: number): number | undefined | null {
  if (choice.mode === 'end') return undefined
  const value = Number(choice.count)
  if (!Number.isInteger(value) || value < 1) return null
  const stopAt = choice.mode === 'next' ? base + value : value
  return stopAt > base ? stopAt : null
}

export type StepState ='done' | 'now' | 'stopped' | 'wait'

/** The steps every planned chapter goes through, in pipeline order. */
export interface ChapterFlow {
  script: StepState
  cast: StepState
  panels: StepState
  drawn: StepState
  /** Progress for the current or stopped step, such as `18/34`. */
  now: string | null
}

type Designs = Pick<Adaptation, 'props' | 'places'>

/** The looks, props and places a chapter's script shows, and how many of their sheets are not drawn yet. */
export function chapterLooks(
  chapter: MangaChapter,
  characters: readonly Character[],
  designs: Designs,
): { names: string[]; props: string[]; places: string[]; missing: number } {
  const panels = (chapter.script ?? []).flatMap((page) => page.panels)
  const ids = new Set(panels.flatMap((panel) => panel.looks))
  const propIds = new Set(panels.flatMap((panel) => panel.props ?? []))
  const placeIds = new Set(panels.flatMap((panel) => (panel.place ? [panel.place] : [])))
  const names: string[] = []
  let missing = 0
  for (const character of characters) {
    for (const look of character.looks) {
      if (!ids.has(look.id)) continue
      names.push(isMainLook(look) ? character.name : `${character.name} (${look.name})`)
      if (!look.sheetKey) missing++
    }
  }
  const shown = (designs.props ?? []).filter((prop) => propIds.has(prop.id))
  const settings = (designs.places ?? []).filter((place) => placeIds.has(place.id))
  missing += [...shown, ...settings].filter((item) => !item.sheetKey).length
  return { names, props: shown.map((prop) => prop.name), places: settings.map((place) => place.name), missing }
}

const ALL_DONE: ChapterFlow = { script: 'done', cast: 'done', panels: 'done', drawn: 'done', now: null }
const ALL_WAIT: ChapterFlow = { script: 'wait', cast: 'wait', panels: 'wait', drawn: 'wait', now: null }

/** `panelsDone` is the live count while drawing; the stored one is only written per composed page. */
export function chapterFlow(
  chapter: MangaChapter,
  characters: readonly Character[],
  designs: Designs,
  activity: AdaptActivity,
  panelsDone = chapter.panelsDone,
): ChapterFlow {
  const panels = `${Math.max(panelsDone, chapter.panelsDone)}/${chapter.panelsTotal}`
  if (chapter.status === 'drawn') return ALL_DONE
  if (chapter.status === 'stopped') {
    if (!chapter.script) return { ...ALL_WAIT, script: 'stopped' }
    const castStopped = chapter.panelsDone === 0 && chapterLooks(chapter, characters, designs).missing > 0
    return castStopped
      ? { script: 'done', cast: 'stopped', panels: 'wait', drawn: 'wait', now: null }
      : { script: 'done', cast: 'done', panels: 'stopped', drawn: 'wait', now: panels }
  }
  if (activity.scripting.includes(chapter.number)) return { ...ALL_WAIT, script: 'now' }
  if (!chapter.script) return ALL_WAIT
  if (activity.cast?.chapters.includes(chapter.number)) {
    return { script: 'done', cast: 'now', panels: 'wait', drawn: 'wait', now: `${activity.cast.done}/${activity.cast.total}` }
  }
  if (chapter.status === 'drawing') return { script: 'done', cast: 'done', panels: 'now', drawn: 'wait', now: panels }
  const cast = chapterLooks(chapter, characters, designs).missing ? 'wait' : 'done'
  return { script: 'done', cast, panels: 'wait', drawn: 'wait', now: null }
}

function either(numbers: readonly number[]): string {
  return numbers.length > 1 ? `${numbers.slice(0, -1).join(', ')} or ${numbers.at(-1)}` : String(numbers[0])
}

/** What a chapter row says after its novel chapters. */
export function waitingDetail(chapter: MangaChapter, activity: AdaptActivity, adaptation: Adaptation): string | null {
  if (chapter.status === 'drawn') return `${chapter.pageCount} pages`
  if (pastStop(adaptation, chapter)) return 'past the stop point'
  if (adaptation.status === 'paused') return 'paused'
  if (chapter.status === 'stopped') return 'stopped'
  if (activity.scripting.includes(chapter.number)) {
    const text = activity.text?.[chapter.number]
    return text?.reason ?? (text?.stage === 'beats' ? 'writing beats' : 'writing storyboard')
  }
  if (!chapter.script) {
    const writing = activity.scripting.filter((number) => number < chapter.number)
    return writing.length ? `script starts after chapter ${Math.max(...writing)}` : 'waiting for a script'
  }
  if (chapter.status === 'queued') {
    const drawing = activity.drawing.filter((number) => number !== chapter.number)
    return drawing.length ? `starts after chapter ${either(drawing)}` : 'next up'
  }
  return `${chapter.script.length} pages`
}

export interface FlaggedPanel {
  chapter: MangaChapter
  page: number
  panel: number
  issue: string
  tries: number
}

export function panelCheckIssue(check: PanelCheck | undefined): string {
  return check?.status === 'unchecked' ? 'Image check unavailable. Review this panel.' : check?.issue ?? ''
}

/** Flagged and unchecked panels awaiting your review, in reading order. */
export function flaggedPanels(chapters: readonly MangaChapter[]): FlaggedPanel[] {
  return chapters.flatMap((chapter) =>
    (chapter.script ?? []).flatMap((page, pageIndex) =>
      page.panels.flatMap((panel, panelIndex) =>
        panel.check?.status === 'flagged' || panel.check?.status === 'unchecked'
          ? [{ chapter, page: pageIndex + 1, panel: panelIndex + 1, issue: panelCheckIssue(panel.check), tries: panel.check.tries }]
          : [],
      ),
    ),
  )
}

/** The pages each beat lands on, by beat index. */
export function beatPages(chapter: MangaChapter): Map<number, number[]> {
  const pages = new Map<number, number[]>()
  ;(chapter.script ?? []).forEach((page, pageIndex) => {
    for (const panel of page.panels) {
      if (panel.beat === undefined) continue
      const list = pages.get(panel.beat) ?? []
      if (!list.includes(pageIndex + 1)) list.push(pageIndex + 1)
      pages.set(panel.beat, list)
    }
  })
  return pages
}

export function pageSpan(pages: readonly number[]): string {
  if (!pages.length) return 'No page'
  const first = Math.min(...pages)
  const last = Math.max(...pages)
  return first === last ? `Page ${first}` : `Pages ${first} to ${last}`
}

export function textLine(item: TextItem): string {
  if (item.kind === 'caption') return `Caption: ${item.line}`
  if (item.kind === 'sfx') return `SFX: ${item.line}`
  const line = item.kind === 'thought' ? `(${item.line})` : item.line
  return item.speaker ? `${item.speaker}: ${line}` : line
}
