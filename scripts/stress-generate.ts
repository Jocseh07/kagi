import { execFile } from 'node:child_process'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'

import { createFileJournal } from '../desktop/src/journal-store'
import { writeBeats } from '../src/lib/adapt/beats'
import type { JournalEvent, JournalOptions, JournalStore, GenerationRecord, GenerationStage } from '../src/lib/adapt/journal/types'
import { planBatch, sourcePart } from '../src/lib/adapt/planner'
import type { BatchChapter, Plan } from '../src/lib/adapt/planner'
import { writeScript } from '../src/lib/adapt/script'
import type { AdaptSettings } from '../src/lib/adapt/settings'
import { applyGenerationMode, ADAPT_DEFAULTS } from '../src/lib/adapt/settings-model'
import type { Adaptation, Beat, Character, MangaChapter, Place, Prop, ScriptPage, StoryMemory } from '../src/lib/adapt/store'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const exec = promisify(execFile)
const SITE = 'https://novelfull.com'
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
const HELP = `Runs the app's plan, beats and storyboard stages on real novel chapters and logs every attempt.

bun run stress:generate [--novel <novelfull url or slug>] [--chapters 1-10]
bun run stress:generate --text chapter.txt
bun run stress:generate --resume .tmp/stress-generate/<slug>/run-<id>

  --novel        NovelFull novel; default: first title on "Most popular"
  --chapters     source chapters to read, default 1-10
  --text         a local chapter file instead of NovelFull (one source chapter)
  --resume       reuse plan.json and saved beats from an earlier run; reruns only what failed
  --mode         fast | balanced (default fast)
  --style        manga | webtoon | sketch (default webtoon)
  --model        overrides the planning and script model
  --endpoint     default http://localhost:8317/v1, or KAGI_GENERATION_ENDPOINT
  --max-requests cap on model requests, default 150
API key: KAGI_GENERATION_API_KEY. Full prompts and replies: bun scripts/generations.ts show <id> --dir <run>/journal`

type ChapterResult = { number: number; title: string; novelChapters: number[]; beats?: { beats: Beat[]; cut: string[] }; script?: ScriptPage[]; error?: { stage: 'beats' | 'script'; message: string } }

function append(fd: number, value: unknown): void {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
  let offset = 0
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset)
  fsyncSync(fd)
}

/** Cloudflare refuses Bun's and Node's TLS fingerprint on NovelFull, and curl's passes. */
async function page(url: string): Promise<string> {
  const { stdout } = await exec('curl', ['-sSfL', '--max-time', '30', '-A', USER_AGENT, '-H', 'Accept: text/html,application/xhtml+xml', '-H', 'Accept-Language: en-US,en;q=0.9', url], { maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

function decode(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d' }
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === '#') return String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)))
    return named[entity.toLowerCase()] ?? whole
  })
}

function slugFromPath(href: string): string {
  return (href.split('?')[0].split('#')[0].split('/').filter(Boolean).pop() ?? '').replace(/\.html?$/i, '')
}

/** The inner HTML of the element whose opening tag starts at `start`, by counting nested divs. */
function divContent(html: string, start: number): string {
  const open = html.indexOf('>', start) + 1
  const tag = /<(\/?)div\b[^>]*>/gi
  tag.lastIndex = open
  let depth = 1
  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    depth += match[1] ? -1 : 1
    if (depth === 0) return html.slice(open, match.index)
  }
  return html.slice(open)
}

/** Mirrors `NovelFull.parseChapterText` then `plainText`: blocks with no paragraph are adverts, the rest is the text content. */
function chapterText(html: string): string {
  const start = html.search(/<div[^>]*id=["'](chapter-content|chr-content)["']/i)
  if (start < 0) throw new Error('NovelFull returned a page with no chapter body.')
  let body = divContent(html, start).replace(/<(script|style|noscript|iframe|ins)\b[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '')
  const innermost = /<(div|h[1-6])\b[^>]*>((?:(?!<div\b|<h[1-6]\b)[\s\S])*?)<\/\1>/i
  for (let match = innermost.exec(body); match; match = innermost.exec(body)) {
    body = body.slice(0, match.index) + (/<p\b/i.test(match[2]) ? match[2] : '') + body.slice(match.index + match[0].length)
  }
  const text = decode(body.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|blockquote|h[1-6])>/gi, '\n\n').replace(/<[^>]*>/g, ''))
    .replace(/[^\S\n]*\n[^\S\n]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!text) throw new Error('NovelFull returned an empty chapter body.')
  return text
}

async function firstPopular(): Promise<string> {
  const html = await page(`${SITE}/most-popular?page=1`)
  const href = /<h3[^>]*class="[^"]*title[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"/i.exec(html)?.[1]
  if (!href) throw new Error('No novel on the Most popular page')
  return slugFromPath(href)
}

async function fetchNovel(slug: string, from: number, to: number, cache: string): Promise<{ title: string; batch: BatchChapter[] }> {
  mkdirSync(cache, { recursive: true })
  const listPath = resolve(cache, 'list.json')
  let saved = existsSync(listPath) ? JSON.parse(readFileSync(listPath, 'utf8')) as { title: string; chapters: { key: string; name: string }[] } : undefined
  if (!saved || saved.chapters.length < to) {
    const novel = await page(`${SITE}/${slug}.html`)
    const title = decode(/<h3[^>]*class="title"[^>]*>([\s\S]*?)<\/h3>/i.exec(novel)?.[1]?.replace(/<[^>]*>/g, '').trim() ?? slug)
    const id = /id="rating"[^>]*data-novel-id="(\d+)"/i.exec(novel)?.[1]
    const route = novel.includes('ajaxChapterOptionUrl') ? 'ajax-chapter-option' : 'ajax/chapter-archive'
    const list = id ? await page(`${SITE}/${route}?novelId=${id}`) : ''
    const options = [...list.matchAll(/<option[^>]*value="([^"]+)"[^>]*>([\s\S]*?)<\/option>/gi)].map((match) => ({ href: match[1], name: match[2] }))
    const anchors = [...novel.matchAll(/<ul class="list-chapter">([\s\S]*?)<\/ul>/gi)].flatMap((block) => [...block[1].matchAll(/<a[^>]*href="([^"]+)"[^>]*?(?:title="([^"]*)")?[^>]*>([\s\S]*?)<\/a>/gi)].map((match) => ({ href: match[1], name: match[2] || match[3] })))
    const chapters = (options.length ? options : anchors)
      .map((node) => ({ key: slugFromPath(node.href), name: decode(node.name.replace(/<[^>]*>/g, '').trim()) }))
      .filter((node) => node.key && node.key !== slug)
    saved = { title, chapters }
    writeFileSync(listPath, JSON.stringify(saved, null, 2))
  }
  if (saved.chapters.length < to) throw new Error(`${slug} lists ${saved.chapters.length} chapters, fewer than ${to}`)
  const batch: BatchChapter[] = []
  for (let index = from; index <= to; index++) {
    const chapter = saved.chapters[index - 1]
    const file = resolve(cache, `chapter-${index}.txt`)
    if (!existsSync(file)) {
      writeFileSync(file, chapterText(await page(`${SITE}/${slug}/${chapter.key}.html`)))
      await sleep(500)
    }
    batch.push({ ref: { index, url: `/${slug}/chapter/${chapter.key}`, name: chapter.name, memo: { slug } }, text: readFileSync(file, 'utf8') })
  }
  return { title: saved.title, batch }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    novel: { type: 'string' }, chapters: { type: 'string' }, text: { type: 'string' }, resume: { type: 'string' },
    mode: { type: 'string' }, style: { type: 'string' }, model: { type: 'string' }, endpoint: { type: 'string' }, 'max-requests': { type: 'string' }, help: { type: 'boolean' },
  }, strict: true })
  if (values.help) return console.log(HELP)

  const mode = values.mode ?? 'fast'
  if (mode !== 'fast' && mode !== 'balanced') throw new Error('--mode is fast or balanced')
  const style = values.style ?? 'webtoon'
  if (style !== 'manga' && style !== 'webtoon' && style !== 'sketch') throw new Error('--style is manga, webtoon or sketch')
  const endpoint = (values.endpoint ?? process.env.KAGI_GENERATION_ENDPOINT ?? 'http://localhost:8317/v1').replace(/\/+$/, '')
  let settings: AdaptSettings = applyGenerationMode({ ...ADAPT_DEFAULTS, mode, endpoint, apiKey: process.env.KAGI_GENERATION_API_KEY ?? '' })
  if (values.model) settings = { ...settings, planningModel: values.model, scriptModel: values.model }
  const maxRequests = Number(values['max-requests'] ?? 150)
  if (!Number.isInteger(maxRequests) || maxRequests < 1) throw new Error('--max-requests must be a positive integer')

  const resumed = values.resume ? resolve(ROOT, values.resume) : undefined
  const previous = resumed ? JSON.parse(readFileSync(resolve(resumed, 'run.json'), 'utf8')) as { slug: string; title: string; batch: BatchChapter[]; plan?: Plan; chapters?: ChapterResult[] } : undefined
  let slug: string
  let title: string
  let batch: BatchChapter[]
  if (previous) ({ slug, title, batch } = previous)
  else if (values.text) {
    slug = basename(values.text).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    title = slug
    batch = [{ ref: { index: 1, url: `/${slug}/chapter/1`, name: 'Chapter 1' }, text: readFileSync(values.text, 'utf8').trim() }]
  } else {
    slug = values.novel ? slugFromPath(values.novel) : await firstPopular()
    const [from, to] = (values.chapters ?? '1-10').split('-').map(Number)
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) throw new Error('--chapters is a range like 1-10')
    ;({ title, batch } = await fetchNovel(slug, from, to, resolve(ROOT, '.tmp/stress-generate', slug, 'chapters')))
  }

  const run = resolve(ROOT, '.tmp/stress-generate', slug, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  mkdirSync(run, { recursive: true })
  const attemptsFd = openSync(resolve(run, 'attempts.jsonl'), 'wx', 0o600)
  const log = (value: Record<string, unknown>) => { append(attemptsFd, value); console.log(JSON.stringify(value)) }
  log({ event: 'run', run: run.slice(ROOT.length + 1), slug, title, chapters: batch.map((chapter) => chapter.ref.index), chars: batch.map((chapter) => chapter.text.length), mode, style, planningModel: settings.planningModel, scriptModel: settings.scriptModel, endpoint, resumed: values.resume })

  let requests = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith(endpoint) && ++requests > maxRequests) throw new Error(`Request cap ${maxRequests} reached`)
    return realFetch(input, init)
  }) as typeof fetch

  const file = await createFileJournal(resolve(run, 'journal'))
  const runs = new Map<string, GenerationRecord>()
  const store: JournalStore = {
    ...file,
    putRun: async (record) => { runs.set(record.id, record); await file.putRun(record) },
    putEvent: async (event: JournalEvent) => {
      await file.putEvent(event)
      const record = runs.get(event.generationId)
      const where = { stage: record?.stage, chapter: record?.target?.chapter, generation: event.generationId, attempt: event.attempt }
      if (event.kind === 'validation') {
        const errors = event.message ? event.message.split('\n') : []
        log({ event: 'validation', ...where, ok: errors.length === 0, errors })
      } else if (event.kind === 'transport-error') log({ event: 'transport-error', ...where, message: event.message })
      else if (event.kind === 'response' && event.status && event.status >= 400) log({ event: 'http-error', ...where, status: event.status })
    },
  }
  const journal = (stage: GenerationStage, chapter?: number): JournalOptions => ({ store, context: { stage, target: { adaptationId: slug, title, chapter } } })
  const onAttempt = (stage: string, chapter?: number) => (event: { attempt: number; model: string; reason?: string }) => log({ event: 'attempt', stage, chapter, ...event })

  const save = (plan: Plan | undefined, chapters: ChapterResult[]) => writeFileSync(resolve(run, 'run.json'), JSON.stringify({ slug, title, batch, plan, chapters }, null, 2))

  let adaptation: Adaptation = {
    id: slug, sourceId: values.text ? 'local' : 'novelfull', novelUrl: `/${slug}`, novelMemo: { slug }, title, style, styleNotes: '',
    novelChapterCount: batch.length, readThrough: 0, skipped: [], status: 'active', error: null, checkedAt: 0, createdAt: Date.now(), skipPrologue: false, checkPanels: false,
  }
  const started = performance.now()
  const stats = { plan: { ok: 0, failed: 0 }, beats: { ok: 0, failed: 0 }, script: { ok: 0, failed: 0 } }

  let plan = previous?.plan
  if (!plan) {
    const cast = new Map<string, Character>()
    const props: Prop[] = []
    const places: Place[] = []
    const chapters: MangaChapter[] = []
    let memory: StoryMemory | undefined
    for (let from = 0; from < batch.length; from += settings.readAhead) {
      const group = batch.slice(from, from + settings.readAhead)
      const begin = performance.now()
      try {
        const part = await planBatch(settings, adaptation, group, [...cast.values()], chapters.at(-1), (chapters.at(-1)?.plan ?? 0) + 1, undefined, { ...journal('plan', (chapters.at(-1)?.number ?? 0) + 1), onAttempt: onAttempt('plan') })
        for (const character of part.characters) cast.set(character.id, character)
        props.push(...part.props)
        places.push(...part.places)
        chapters.push(...part.chapters)
        memory = part.memory
        adaptation = { ...adaptation, readThrough: from + group.length, props: [...props], places: [...places], memory }
        stats.plan.ok++
        log({ event: 'stage', stage: 'plan', novelChapters: group.map((chapter) => chapter.ref.index), ok: true, ms: Math.round(performance.now() - begin), mangaChapters: part.chapters.map((chapter) => chapter.number) })
      } catch (error) {
        stats.plan.failed++
        log({ event: 'stage', stage: 'plan', novelChapters: group.map((chapter) => chapter.ref.index), ok: false, ms: Math.round(performance.now() - begin), error: error instanceof Error ? error.message : String(error) })
        break
      }
    }
    plan = { skip: [], chapters, characters: [...cast.values()], props, places, memory: memory ?? { summary: '', threads: [], updatedThrough: 0 } }
  }
  adaptation = { ...adaptation, props: plan.props, places: plan.places, memory: plan.memory }
  const texts = new Map(batch.map((chapter) => [chapter.ref.index, chapter]))
  const done = new Map((previous?.chapters ?? []).map((chapter) => [chapter.number, chapter]))
  const results: ChapterResult[] = plan.chapters.map((chapter) => {
    const prior = done.get(chapter.number)
    return { number: chapter.number, title: chapter.title, novelChapters: chapter.novelChapters.map((ref) => ref.index), beats: prior?.beats, script: prior?.error ? undefined : prior?.script }
  })
  save(plan, results)

  const scriptOne = async (chapter: MangaChapter, result: ChapterResult) => {
    if (result.script) return
    const earliest = Math.min(...chapter.novelChapters.map((ref) => ref.index))
    const memory = chapter.contextMemory !== undefined ? chapter.contextMemory ?? undefined : adaptation.memory && adaptation.memory.updatedThrough < earliest ? adaptation.memory : undefined
    const places = adaptation.places ?? []
    let stage: 'beats' | 'script' = 'beats'
    const begin = performance.now()
    try {
      if (!result.beats) {
        const parts = chapter.novelChapters.flatMap((ref) => {
          const text = sourcePart(texts.get(ref.index)?.text ?? '', ref.part)
          return text ? [`Novel chapter ${ref.index}: ${ref.name}${ref.part ? `, part ${ref.part.index} of ${ref.part.total}` : ''}\n${text}`] : []
        })
        if (!parts.length) throw new Error('The novel text for this chapter is empty.')
        result.beats = await writeBeats(settings, parts.join('\n\n'), memory, plan.characters, places, undefined, { ...journal('beats', chapter.number), onAttempt: onAttempt('beats', chapter.number) })
        stats.beats.ok++
        log({ event: 'stage', stage: 'beats', chapter: chapter.number, ok: true, ms: Math.round(performance.now() - begin), beats: result.beats.beats.length, cut: result.beats.cut.length })
        save(plan, results)
      }
      stage = 'script'
      const scriptStart = performance.now()
      const wearing = chapter.wearing && Object.fromEntries(Object.entries(chapter.wearing).filter(([id, look]) => plan.characters.some((character) => character.id === id && character.looks.some((entry) => entry.id === look))))
      result.script = await writeScript(settings, { beats: result.beats.beats, memory, characters: plan.characters, props: adaptation.props ?? [], places, style: adaptation.style, wearing: wearing && Object.keys(wearing).length ? wearing : undefined }, undefined, { ...journal('script', chapter.number), onAttempt: onAttempt('script', chapter.number) })
      result.error = undefined
      stats.script.ok++
      log({ event: 'stage', stage: 'script', chapter: chapter.number, ok: true, ms: Math.round(performance.now() - scriptStart), pages: result.script.length, panels: result.script.reduce((sum, item) => sum + item.panels.length, 0) })
    } catch (error) {
      stats[stage].failed++
      result.error = { stage, message: error instanceof Error ? error.message : String(error) }
      log({ event: 'stage', stage, chapter: chapter.number, ok: false, ms: Math.round(performance.now() - begin), error: result.error.message })
    }
    save(plan, results)
  }

  const queue = plan.chapters.map((chapter, index) => () => scriptOne(chapter, results[index]))
  await Promise.all(Array.from({ length: Math.max(1, settings.scriptsAhead) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await next()
  }))

  globalThis.fetch = realFetch
  const summary = { event: 'summary', run: run.slice(ROOT.length + 1), seconds: Math.round((performance.now() - started) / 1000), requests, stats, failed: results.filter((result) => result.error).map((result) => ({ chapter: result.number, ...result.error })) }
  log(summary)
  closeSync(attemptsFd)
  if (summary.failed.length || stats.plan.failed) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
