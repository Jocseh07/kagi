import { afterEach, describe, expect, it } from 'bun:test'

import { accountDialogue, missingLines, validateBeats, writeBeats } from '../src/lib/adapt/beats'
import { validateCheckResult } from '../src/lib/adapt/check'
import { MalformedReplyError } from '../src/lib/adapt/client'
import type { ChatAttempt } from '../src/lib/adapt/client'
import { planBatch, validatePlan } from '../src/lib/adapt/planner'
import { validateScript, writeScript } from '../src/lib/adapt/script'
import type { StoryboardInput } from '../src/lib/adapt/script'
import type { AdaptSettings } from '../src/lib/adapt/settings'
import type { Adaptation, Beat, ScriptPage, ScriptPart, TextItem } from '../src/lib/adapt/store'

const originalFetch = globalThis.fetch
const originalTimeout = AbortSignal.timeout

afterEach(() => {
  globalThis.fetch = originalFetch
  AbortSignal.timeout = originalTimeout
})

const settings: AdaptSettings = {
  endpoint: 'http://localhost:8317/v1', apiKey: '', planningModel: 'planner', scriptModel: 'writer', imageModel: 'image',
  concurrency: 1, chaptersAtOnce: 1, scriptsAhead: 1, readAhead: 1,
}

function queuedReplies(replies: unknown[]) {
  const requests: { messages: { role: string; content: string }[]; model: string }[] = []
  globalThis.fetch = (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)))
    const draft = replies[requests.length - 1]
    return Response.json({ choices: [{ message: { content: JSON.stringify(draft ?? {}) }, finish_reason: 'stop' }] })
  }) as typeof fetch
  return requests
}

function beat(lines: [string, string][] = []): Beat {
  return { moment: 'The guard commits to holding the gate.', weight: 'key', cast: [], lines }
}

function speech(line: string): TextItem {
  return { kind: 'speech', speaker: 'Guard', speakerAt: 'off', line, anchor: 'tl' }
}

function storyboard(): { input: StoryboardInput; pages: ScriptPage[] } {
  const input: StoryboardInput = {
    beats: [beat([['Guard', 'Hold the gate until I return.']]), { ...beat(), moment: 'The messenger leaves.', weight: 'normal' }],
    memory: undefined, characters: [], props: [], places: [], style: 'manga',
  }
  const pages: ScriptPage[] = Array.from({ length: 4 }, (_, page) => ({
    layout: 'tiers-2',
    panels: Array.from({ length: 2 }, (_, panel) => ({
      beat: page < 2 ? 0 : 1, shot: 'Wide establishing', looks: [], props: [],
      prompt: `The guard braces against the gate in panel ${page * 2 + panel + 1}.`,
      text: page === 0 ? [speech(panel === 0 ? 'Hold the gate' : 'until I return.')] : [],
    })),
  }))
  return { input, pages }
}

const batch = [
  { ref: { index: 1, name: 'Arrival', url: '/1' }, text: 'The guard arrives.' },
  { ref: { index: 2, name: 'Departure', url: '/2' }, text: 'The guard leaves.' },
]

function planDraft() {
  return {
    skip: [] as number[],
    chapters: batch.map(({ ref }) => ({ title: ref.name, summary: `The story reaches ${ref.name}.`, novelChapters: [ref.index] })),
    characters: [], props: [], places: [], memory: { summary: 'The guard has left.', threads: ['Who holds the gate?'] },
  }
}

const adaptation: Adaptation = {
  id: 'fixture', sourceId: 'fixture', novelUrl: '/novel', title: 'Gate', style: 'manga', styleNotes: '',
  novelChapterCount: 2, readThrough: 0, skipped: [], status: 'active', error: null, checkedAt: 0, createdAt: 0,
  skipPrologue: true, checkPanels: true,
}

describe('quote occurrences', () => {
  it('does not match go inside forgotten', () => {
    expect(accountDialogue(['go'], ['forgotten'])).toEqual({
      missing: ['go'], errors: ['invented, duplicated, or incomplete dialogue: "forgotten"'], occurrences: [-1], matchedCut: [],
    })
  })

  it('requires every repeated occurrence, including explicit cuts', () => {
    expect(missingLines('"Stop!" He ran. "Stop!"', [beat([['Guard', 'Stop!']])], [])).toEqual(['Stop!'])
    expect(validateBeats({ beats: [beat([['Guard', 'Stop!']])], cut: ['Stop!'] }, '"Stop!" He ran. "Stop!"')).toEqual([])
    expect(accountDialogue(['Stop!'], ['Stop!', 'Stop!']).errors).toEqual(['invented, duplicated, or incomplete dialogue: "Stop!"'])
  })

  it('allows consecutive fragments and punctuation normalization without partial cuts', () => {
    expect(accountDialogue(['Don’t leave, stay here!'], ["don't leave", 'STAY HERE.'])).toEqual({ missing: [], errors: [], occurrences: [0, 0], matchedCut: [] })
    expect(accountDialogue(['Hold the gate'], ['Hold'], ['the gate']).missing).toEqual(['Hold the gate'])
    expect(accountDialogue(['Hold the gate'], ['Hold'], ['the gate']).matchedCut).toEqual([])
  })

  it('matches escaped punctuation without losing occurrence or word checks', () => {
    const source = String.raw`The paper window\u2014pierced with one poke!`
    const fragments = ['The paper window,', 'pierced with one poke!']
    expect(accountDialogue([source], fragments)).toEqual({ missing: [], errors: [], occurrences: [0, 0], matchedCut: [] })
    expect(accountDialogue(['Do not leave.'], [String.raw`Do\u0020not leave.`]).missing).toEqual(['Do not leave.'])
    expect(accountDialogue(['A'], [String.raw`\u0041`]).missing).toEqual(['A'])
    expect(accountDialogue([source], ['The paper window,', 'pierced with two pokes!']).missing).toEqual([source])
    expect(accountDialogue([source, source], fragments).missing).toEqual([source])
    expect(accountDialogue([source], [...fragments, ...fragments]).errors).toHaveLength(2)
    expect(accountDialogue([source], [], [source])).toEqual({ missing: [], errors: [], occurrences: [], matchedCut: [source] })
  })

  it('saves decoded punctuation in new beats and explicit cuts', async () => {
    const dash = String.fromCodePoint(0x2014)
    queuedReplies([{ beats: [beat([['Guard', String.raw`Wait\u2014stay here!`]])], cut: [String.raw`Don\u2019t run!`] }])
    const result = await writeBeats(settings, `"Wait${dash}stay here!" "Don't run!"`, undefined, [], [])
    expect(result.beats[0].lines).toEqual([['Guard', `Wait${dash}stay here!`]])
    expect(result.cut).toEqual(['Don’t run!'])
  })

  it('disambiguates a short quote from the prefix of a longer quote', () => {
    expect(accountDialogue(['Go now', 'Go'], ['Go'], ['Go now'])).toEqual({ missing: [], errors: [], occurrences: [1], matchedCut: ['Go now'] })
  })

  it('keeps multiline quoted speech in the source accounting', () => {
    expect(missingLines('“Hold the gate\nuntil I return.”', [], [])).toEqual(['Hold the gate\nuntil I return.'])
  })

  it('rejects reordered source dialogue and unknown cast references', () => {
    expect(validateBeats({ beats: [beat([['Guard', 'Second'], ['Guard', 'First']])], cut: [] }, '"First" "Second"')).toContain('beats contain dialogue out of source order')
    expect(validateBeats({ beats: [{ ...beat(), cast: ['invented'] }], cut: [] }, '', [])).toContain('beat 1: unknown character "invented"')
  })

  it.each([null, [], { beats: [null], cut: [] }, { beats: [{ ...beat(), lines: [null] }], cut: [] }, { beats: [beat()], cut: [null] }].map((draft) => [draft]))('rejects malformed beat records', (draft) => {
    expect(validateBeats(draft, '')).toEqual(['beats must contain valid moment, weight, place, cast and [speaker, line] records, with a string cut array'])
  })

  it('never turns repeatedly omitted dialogue into an automatic cut', async () => {
    const bad = { beats: [beat()], cut: [] }
    const requests = queuedReplies([bad, bad, bad])
    const events: ChatAttempt[] = []
    await expect(writeBeats(settings, '"Keep this promise."', undefined, [], [], undefined, { onAttempt: (event) => events.push(event) })).rejects.toThrow('line not kept or cut')
    expect(requests.map((request) => request.model)).toEqual(['writer', 'writer', 'planner'])
    expect(events.map((event) => event.attempt)).toEqual([1, 2, 3])
    expect(events[1].reason).toBe('Repairing beat validation errors')
    expect(requests[1].messages[1].content).toContain(JSON.stringify(bad))
  })
})

describe('storyboard boundaries and repair', () => {
  it('preserves split dialogue on consecutive panels', () => {
    const { pages, input } = storyboard()
    expect(validateScript(pages, input)).toEqual([])
  })

  it('recovers saved escaped dialogue and returns readable lettering', async () => {
    const { pages, input } = storyboard()
    input.beats[0].lines = [['Guard', String.raw`Hold the gate\u2014until I return.`]]
    pages[0].panels[0].text = [speech(String.raw`Hold the gate\u2014`)]
    const requests = queuedReplies([{ pages }])
    const result = await writeScript(settings, input)
    expect(result[0].panels[0].text[0].line).toBe('Hold the gate,')
    expect(validateScript(result, input)).toEqual([])
    expect(requests[0].messages[1].content).toContain(`Hold the gate${String.fromCodePoint(0x2014)}until I return.`)
    expect(input.beats[0].lines[0][1]).toBe(String.raw`Hold the gate\u2014until I return.`)
  })

  it.each([
    { shot: '' }, { prompt: ' ' }, { looks: null }, { props: {} }, { text: [null] },
    { text: [{ ...speech('Hold'), kind: 'dialogue' }] }, { text: [{ ...speech('Hold'), anchor: 'middle' }] },
    { text: [{ ...speech('Hold'), line: null }] }, { camera: [] },
  ])('rejects malformed panels before inspecting nested fields', (mutation) => {
    const { pages, input } = storyboard()
    Object.assign(pages[0].panels[0], mutation)
    expect(validateScript(pages, input)).toEqual(['page 1: invalid page, panel, prompt, shot, reference array or text kind/anchor shape'])
  })

  it.each([null, { layout: 'tiers-2', panels: [null] }, { layout: 'toString', panels: [] }, { layout: { toString: null }, panels: [] }])('rejects malformed pages without coercing unknown values', (page) => {
    expect(validateScript([page], storyboard().input)).toEqual(['page 1: invalid page, panel, prompt, shot, reference array or text kind/anchor shape'])
  })

  it('rejects missing, invented and duplicated dialogue', () => {
    const { pages, input } = storyboard()
    pages[0].panels[1].text = []
    expect(validateScript(pages, input)).toContain('beat 0: missing required dialogue "Hold the gate until I return."')
    pages[0].panels[1].text = [speech('until I return.')]
    pages[1].panels[0].text = [speech('Hold the gate until I return.')]
    expect(validateScript(pages, input)).toContain('beat 0: invented, duplicated, or incomplete dialogue: "Hold the gate until I return."')
  })

  it('accepts split dialogue in one panel and rejects a split that skips a panel', () => {
    const { pages, input } = storyboard()
    pages[0].panels[0].text = [speech('Hold the gate'), { ...speech('until I return.'), anchor: 'tr' }]
    pages[0].panels[1].text = []
    expect(validateScript(pages, input)).toEqual([])
    pages[0].panels[0].text = [speech('Hold the gate')]
    pages[1].panels[0].text = [speech('until I return.')]
    expect(validateScript(pages, input)).toEqual(['beat 0: split dialogue must stay in one panel or run on into the next'])
  })

  it('rejects backward beat order, missing key beats and unknown references', () => {
    const { pages, input } = storyboard()
    pages[3].panels[0].beat = 0
    pages[3].panels[0].looks = ['unknown@main']
    pages[3].panels[0].props = ['unknown-prop']
    pages[3].panels[0].place = 'unknown-place'
    input.beats = [...input.beats, { ...beat(), moment: 'The gate falls.' }]
    const errors = validateScript(pages, input)
    expect(errors).toContain('beats are out of order across the storyboard')
    expect(errors).toContain('key beat 2 has no panel: The gate falls.')
    expect(errors).toContain('page 4 panel 1: unknown look "unknown@main"')
    expect(errors).toContain('page 4 panel 1: unknown prop "unknown-prop"')
    expect(errors).toContain('page 4 panel 1: unknown place "unknown-place"')
  })

  it('rejects a reversed exchange even when each speaker keeps their own words', () => {
    const { pages, input } = storyboard()
    input.beats = [beat([['Guard', 'Wait here.'], ['Messenger', 'I will.']]), input.beats[1]]
    pages[0].panels[0].text = [{ ...speech('I will.'), speaker: 'Messenger' }]
    pages[0].panels[1].text = [speech('Wait here.')]
    expect(validateScript(pages, input)).toContain('beat 0: dialogue out of order')
  })

  it('repairs only a bad page and preserves every good page', async () => {
    const { pages, input } = storyboard()
    const bad = structuredClone(pages)
    bad[1].panels[0].prompt = ''
    const requests = queuedReplies([{ pages: bad }, { pages: [pages[1]] }])
    const events: ChatAttempt[] = []
    const result = await writeScript(settings, input, undefined, { onAttempt: (event) => events.push(event) })
    expect(result).toEqual(pages)
    expect(requests).toHaveLength(2)
    expect(requests[1].messages[1].content).toContain('ONLY replacements for pages 2 in that order')
    expect(requests[1].messages[1].content).toContain(JSON.stringify({ pages: bad }))
    expect(events.map((event) => event.attempt)).toEqual([1, 2])
    expect(events[1].reason).toBe('Repairing invalid storyboard pages')
  })

  it('revalidates cross-page invariants after local repair before accepting output', async () => {
    const { pages, input } = storyboard()
    const bad = structuredClone(pages)
    bad[3].panels[0].prompt = ''
    const backward = structuredClone(pages[3])
    backward.panels.forEach((panel) => { panel.beat = 0 })
    const requests = queuedReplies([{ pages: bad }, { pages: [backward] }, { pages }])
    expect(await writeScript(settings, input)).toEqual(pages)
    expect(requests[1].messages[1].content).toContain('ONLY replacements for pages 4 in that order')
    expect(requests[2].messages[1].content).toContain('beats are out of order across the storyboard')
    expect(requests[2].messages[1].content).toContain('Return a corrected full storyboard')
  })

  it('rejects wrong replacement counts rather than dropping good pages', async () => {
    const { pages, input } = storyboard()
    const bad = structuredClone(pages)
    bad[1].panels[0].prompt = ''
    const requests = queuedReplies([{ pages: bad }, { pages: [] }, { pages: [pages[1]] }])
    expect(await writeScript(settings, input)).toEqual(pages)
    expect(requests[2].messages[1].content).toContain('repair must return exactly the requested pages in order')
  })

  it('shares one total stage deadline across all semantic repairs', async () => {
    const deadlines: number[] = []
    AbortSignal.timeout = (duration) => { deadlines.push(duration); return originalTimeout(duration) }
    const { pages, input } = storyboard()
    const bad = structuredClone(pages)
    bad[1].panels[0].prompt = ''
    queuedReplies([{ pages: bad }, { pages: [pages[1]] }])
    expect(await writeScript(settings, input)).toEqual(pages)
    expect(deadlines.filter((duration) => duration === 1_800_000)).toHaveLength(1)
    expect(deadlines.filter((duration) => duration === 900_000)).toHaveLength(2)
  })

  function sectionedInput(): StoryboardInput {
    return {
      beats: Array.from({ length: 9 }, (_, index) => ({ ...beat(), moment: `The guard holds moment ${index}.` })),
      memory: undefined, characters: [], props: [], places: [], style: 'manga',
    }
  }

  function sectionPages(beats: number[][]): { pages: ScriptPage[] } {
    return {
      pages: beats.map((panels) => ({
        layout: 'tiers-2',
        panels: panels.map((index) => ({ beat: index, shot: 'Wide establishing', looks: [], props: [], prompt: 'The guard braces.', text: [] })),
      })),
    }
  }

  function padded(pages: ScriptPage[], length: number): ScriptPage[] {
    return [...pages, ...Array.from({ length: length - pages.length }, () => structuredClone(pages.at(-1)!))]
  }

  it('sends a storyboard over twice its page target back once and accepts the repair', async () => {
    const { pages, input } = storyboard()
    expect(validateScript(padded(pages, 12), input)).toEqual([])
    const long = padded(pages, 13)
    expect(validateScript(long, input)).toEqual(['too long: 13 pages; use at most 12 pages and aim for 6'])
    const requests = queuedReplies([{ pages: long }, { pages }])
    expect(await writeScript(settings, input)).toEqual(pages)
    expect(requests).toHaveLength(2)
    expect(requests[1].messages[1].content).toContain('too long: 13 pages; use at most 12 pages')
  })

  it('fails the stage when the repair is still over the page limit', async () => {
    const { pages, input } = storyboard()
    const long = padded(pages, 13)
    const requests = queuedReplies([{ pages: long }, { pages: long }, { pages }])
    await expect(writeScript(settings, input)).rejects.toThrow('Storyboard ran to 13 pages, over the 12-page limit. Retry, or switch the script model in Settings.')
    expect(requests).toHaveLength(2)
  })

  it('raises the page limit when key beats need more pages than the target', () => {
    const input: StoryboardInput = { ...sectionedInput(), beats: Array.from({ length: 50 }, (_, index) => ({ ...beat(), moment: `The guard holds moment ${index}.` })) }
    const spread = (count: number) => sectionPages(Array.from({ length: count }, (_, page) => [0, 1].map((panel) => Math.floor(((page * 2 + panel) * 50) / (count * 2))))).pages
    expect(validateScript(spread(68), input)).toEqual([])
    expect(validateScript(spread(69), input)).toEqual(['too long: 69 pages; use at most 68 pages and aim for 16'])
  })

  it('raises the page limit to fit a panel for every dialogue beat', () => {
    const input: StoryboardInput = {
      ...sectionedInput(),
      beats: Array.from({ length: 120 }, (_, index) => ({ ...beat([['Guard', `Hold line ${index}.`]]), weight: 'normal' })),
    }
    const minimum: ScriptPage[] = Array.from({ length: 40 }, (_, page) => ({
      layout: 'tiers-3',
      panels: Array.from({ length: 3 }, (_, panel) => ({
        beat: page * 3 + panel, shot: 'Wide establishing', looks: [], props: [], prompt: 'The guard braces.', text: [speech(`Hold line ${page * 3 + panel}.`)],
      })),
    }))
    expect(validateScript(minimum, input)).toEqual([])
    const long = [...minimum, ...sectionPages(Array.from({ length: 41 }, () => [119, 119])).pages]
    expect(validateScript(long, input)).toEqual(['too long: 81 pages; use at most 80 pages and aim for 16'])
  })

  it('splits a section that keeps failing and keeps the halves in beat order', async () => {
    const input = sectionedInput()
    const three = sectionPages([[0, 0], [1, 1], [2, 2]])
    const requests = queuedReplies([three, {}, {}, {}, sectionPages([[0, 0]]), sectionPages([[0, 0], [1, 1]]), three])
    const result = await writeScript(settings, input)
    expect(requests).toHaveLength(7)
    expect(requests[4].messages[1].content).toContain('Earlier in this chapter')
    expect(result.flatMap((page) => page.panels.map((panel) => panel.beat))).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8])
    expect(validateScript(result, input)).toEqual([])
  })

  it('names the failed part and resumes after the parts already saved', async () => {
    const input = sectionedInput()
    const three = sectionPages([[0, 0], [1, 1], [2, 2]])
    const saved: ScriptPart[] = []
    const requests = queuedReplies([three])
    await expect(writeScript(settings, input, undefined, { onPart: (part) => { saved.push(part) } }))
      .rejects.toThrow('Storyboard part 2 of 4 (beat 3) failed after 3 tries')
    expect(requests).toHaveLength(7)
    expect(saved.map(({ from, to }) => [from, to])).toEqual([[0, 3]])
    const resumed = queuedReplies([three, three])
    const result = await writeScript(settings, input, undefined, { parts: saved })
    expect(resumed).toHaveLength(2)
    expect(validateScript(result, input)).toEqual([])
  })
})

describe('planner boundaries and chapter context', () => {
  it.each([
    null, { ...planDraft(), chapters: [null] }, { ...planDraft(), characters: [null] },
    { ...planDraft(), memory: { summary: 'Now', threads: [null] } }, { ...planDraft(), places: [null] },
    { ...planDraft(), characters: [{ id: 'guard', name: 'Guard', role: '', appearance: '', now: '', looks: [null] }] },
  ])('rejects malformed nested planning records', (draft) => {
    expect(validatePlan(draft, batch, false)).toEqual(['plan must contain valid skip, chapters, characters, looks, props, places and memory records'])
  })

  it('rejects duplicate, missing and unknown source references', () => {
    const duplicate = planDraft()
    duplicate.chapters[1].novelChapters = [1]
    expect(validatePlan(duplicate, batch, false)).toContain('chapters must cover novel chapters 1, 2 in order, each once; got 1, 1')
    const skipped = planDraft()
    skipped.skip = [3, 3]
    expect(validatePlan(skipped, batch, true)).toContain('skip contains duplicate or unknown novel chapters')
    const missing = planDraft()
    missing.chapters.pop()
    expect(validatePlan(missing, batch, false)).toContain('chapters must cover novel chapters 1, 2 in order, each once; got 1')
  })

  it('enforces one source chapter per fast chapter without skipping story', () => {
    const combined = planDraft()
    combined.chapters = [{ title: 'Gate', summary: 'The guard arrives and leaves.', novelChapters: [1, 2] }]
    expect(validatePlan(combined, batch, false, false)).toEqual([])
    expect(validatePlan(combined, batch, false, true)).toContain('fast mode requires one source chapter per manga chapter')
    const skipped = planDraft()
    skipped.skip = [1]
    skipped.chapters.shift()
    expect(validatePlan(skipped, batch, true, true)).toContain('skip must be [] for this batch')
  })

  it('snapshots prior memory, preserves long source text and repairs the invalid plan', async () => {
    const prior = { summary: 'Before the gate opens.', threads: ['Who opens it?'], updatedThrough: 0 }
    const bad = planDraft()
    bad.chapters[1].novelChapters = [1]
    const requests = queuedReplies([bad, planDraft()])
    const fullBatch = [{ ...batch[0], text: `${'a'.repeat(40_001)} important ending` }, batch[1]]
    const events: ChatAttempt[] = []
    const result = await planBatch({ ...settings, mode: 'fast' }, { ...adaptation, memory: prior }, fullBatch, [], undefined, 1, undefined, { onAttempt: (event) => events.push(event) })
    expect(result.chapters.map((chapter) => chapter.novelChapters.map((ref) => ref.index))).toEqual([[1], [2]])
    expect(result.chapters.map((chapter) => chapter.contextMemory)).toEqual([prior, prior])
    prior.threads.push('Changed after planning')
    expect(result.chapters[0].contextMemory?.threads).toEqual(['Who opens it?'])
    expect(result.memory.summary).toBe('The guard has left.')
    expect(requests[0].messages[1].content).toContain('important ending')
    expect(requests[1].messages[1].content).toContain(JSON.stringify(bad))
    expect(events.map((event) => event.attempt)).toEqual([1, 2])
    expect(events[1].reason).toBe('Repairing chapter plan validation errors')
  })

  it('uses explicit null for the first batch rather than future memory', async () => {
    queuedReplies([planDraft()])
    const result = await planBatch(settings, adaptation, batch, [], undefined, 1)
    expect(result.chapters.map((chapter) => chapter.contextMemory)).toEqual([null, null])
  })
})

describe('panel checker evidence', () => {
  it.each([null, {}, { ok: true }, { ok: false }, { ok: false, issue: '' }, { ok: false, issue: '...' }, { ok: 'true', issue: '' }, { ok: true, issue: 'Remove the text' }])('rejects malformed or contradictory checker results', (reply) => {
    expect(() => validateCheckResult(reply)).toThrow(MalformedReplyError)
  })

  it('accepts explicit success and an actionable failure', () => {
    expect(validateCheckResult({ ok: true, issue: '' })).toEqual({ ok: true })
    expect(validateCheckResult({ ok: false, issue: '  Remove the sign text.  ' })).toEqual({ ok: false, issue: 'Remove the sign text.' })
  })
})
