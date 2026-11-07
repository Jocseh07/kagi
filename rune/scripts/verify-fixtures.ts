import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { BlobReader, BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js'
import { characters, fixtures } from '../../scripts/bench-adapt-fixtures'
import { validatePlan } from '../../src/lib/adapt/planner'
import { validateBeats, accountDialogue, quotedLines } from '../../src/lib/adapt/beats'
import { validateScript } from '../../src/lib/adapt/script'
import type { ScriptPage } from '../../src/lib/adapt/store'
import type { StoryboardInput } from '../../src/lib/adapt/script'

export const MODELS = { planningModel: 'gpt-6-sol(low)', scriptModel: 'gpt-6-sol(low)', imageModel: 'gpt-image-2.5-flare' }
export const UNICODE = '日本語 العربية 👩🏽‍🚀 e\u0301 \u200d Привет'
export const FIXED_TIME = new Date('2020-01-01T00:00:00.000Z')
export const FIXTURES = fixtures.map((fixture) => {
  const panels = fixture.input.beats.flatMap((beat, index) => Array.from({ length: 4 }, (_, panel) => ({
    beat: index, shot: 'Medium two-shot', place: 'clock-room', looks: ['mira@main', 'oren@main'], props: ['brass-key'],
    prompt: `${beat.moment} Mira stands left and Oren stands right. Their feet rest on the stone floor. Soft daylight enters from the window. Both faces show concern. Each hand holds at most one object. The cabinet stands behind Oren. The table stands between them.`,
    text: panel === 0 ? beat.lines.map(([speaker, line], n) => ({ kind: 'speech' as const, speaker, speakerAt: speaker === 'Mira' ? 'left' as const : 'right' as const, line, anchor: n ? 'tr' as const : 'tl' as const })) : [],
  })))
  const pages: ScriptPage[] = Array.from({ length: 6 }, (_, index) => ({ layout: 'tiers-2', panels: panels.slice(index * 2, index * 2 + 2) }))
  return {
    ...fixture, pages, beats: { beats: fixture.input.beats, cut: [] },
    plan: {
      skip: [], chapters: [{ title: fixture.id, novelChapters: [1], summary: fixture.input.beats.map((beat) => beat.moment).join(' '), wearing: { mira: 'main', oren: 'main' } }],
      characters: characters.map((character) => ({ id: character.id, name: character.name, role: character.role, appearance: character.appearance, now: '', looks: [{ id: 'main', name: 'Main', change: '' }] })),
      props: fixture.input.props, places: fixture.input.places,
      memory: { summary: 'Mira brings the brass key to Oren in the clock room.', threads: ['The cabinet must stay closed.'] },
    },
  }
})

export async function validateFixtures(): Promise<void> {
  for (const fixture of FIXTURES) {
    assert.deepEqual(validatePlan(fixture.plan, [{ ref: { index: 1, name: fixture.id, url: '' }, text: fixture.text }], false), [], `${fixture.id}: plan`)
    assert.deepEqual(validateBeats(fixture.beats, fixture.text, fixture.input.places, characters), [], `${fixture.id}: beats`)
    assert.deepEqual(validateScript(fixture.pages, fixture.input), [], `${fixture.id}: script`)
    const actual = fixture.pages.flatMap((page) => page.panels.flatMap((panel) => panel.text.map((text) => text.line)))
    const accounting = accountDialogue(quotedLines(fixture.text), actual)
    assert.deepEqual(accounting.missing, []); assert.deepEqual(accounting.errors, [])
    const lost = structuredClone(fixture.pages)
    for (const page of lost) for (const panel of page.panels) panel.text = []
    assert(validateScript(lost, fixture.input).some((error) => error.includes('missing required dialogue')), 'Canonical validator must reject lost fixture dialogue')
    const unknownLook = structuredClone(fixture.pages)
    unknownLook[0].panels[0].looks = ['missing-character@missing-look']
    assert(validateScript(unknownLook, fixture.input).some((error) => error.includes('unknown look')), 'Missing reference looks must not validate')
    assert(validateBeats(fixture.beats, fixture.text, fixture.input.places, []).length > 0, 'Missing cast must not validate')
    assert(validateBeats({ beats: [], cut: [] }, fixture.text, fixture.input.places, characters).length > 0, 'Empty beats must not discard the chapter')
    assert(validatePlan({ ...fixture.plan, chapters: [] }, [{ ref: { index: 1, name: fixture.id, url: '' }, text: fixture.text }], false).length > 0, 'Empty plans must not omit source coverage')
  }
}

export async function validateSavedScript(raw: unknown, input: StoryboardInput): Promise<void> {
  assert.deepEqual(validateScript(raw, input), [], 'Persisted script failed canonical validator')
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(name: string, bytes: Uint8Array): Buffer {
  const type = Buffer.from(name)
  const result = Buffer.alloc(12 + bytes.length)
  result.writeUInt32BE(bytes.length, 0); type.copy(result, 4); Buffer.from(bytes).copy(result, 8)
  result.writeUInt32BE(crc32(Buffer.concat([type, bytes])), result.length - 4)
  return result
}
export function png(width: number, height: number, seed = 0): Buffer {
  const rows = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * (width * 4 + 1) + 1 + x * 4
    rows[at] = (x + seed) % 256; rows[at + 1] = (y + (seed >>> 8)) % 256; rows[at + 2] = (x ^ y) % 256; rows[at + 3] = 255
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 6 })), chunk('IEND', new Uint8Array())])
}
const xml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
async function archive(path: string, entries: { name: string; text?: string; blob?: Blob }[]): Promise<void> {
  const writer = new ZipWriter(new BlobWriter('application/zip'), { useWebWorkers: false })
  for (const entry of entries) await writer.add(entry.name, entry.blob ? new BlobReader(entry.blob) : new TextReader(entry.text ?? ''), { lastModDate: FIXED_TIME, level: 0 })
  await Bun.write(path, await writer.close())
}
async function epub(path: string, chapters: number): Promise<void> {
  const entries = [
    { name: 'mimetype', text: 'application/epub+zip' },
    { name: 'META-INF/container.xml', text: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
    { name: 'OEBPS/book.opf', text: `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">rune-native-fixture-${chapters}</dc:identifier><dc:title>${chapters === 1 ? 'Brass Key' : 'Thousand Chapters'}</dc:title><dc:language>en</dc:language></metadata><manifest>${Array.from({ length: chapters }, (_, i) => `<item id="c${i}" href="${i}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${Array.from({ length: chapters }, (_, i) => `<itemref idref="c${i}"/>`).join('')}</spine></package>` },
  ]
  for (let i = 0; i < chapters; i++) entries.push({ name: `OEBPS/${i}.xhtml`, text: `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${i + 1}</title></head><body><h1>Chapter ${i + 1}</h1>${FIXTURES[0].text.split('\n').map((line) => `<p>${xml(line)}</p>`).join('')}${chapters > 1 ? `<p>${UNICODE}</p>` : ''}</body></html>` })
  await archive(path, entries)
}
export interface FixturePaths { root: string; novel: string; unicode: string; many: string; comic: string; folder: string; malformed: string; image: string; large: string; hash: string }
export async function createFixtures(root: string): Promise<FixturePaths> {
  await mkdir(root, { recursive: true })
  const novel = join(root, 'Brass Key.epub'), unicode = join(root, 'Unicode.txt'), many = join(root, 'Thousand Chapters.epub'), comic = join(root, 'Gradient.cbz'), folder = join(root, 'Folder Comic'), malformed = join(root, 'broken.epub'), image = join(root, 'panel.png'), large = join(root, 'large.png')
  const small = png(320, 480)
  await Bun.write(image, small); await Bun.write(large, png(4096, 4096))
  await epub(novel, 1); await epub(many, 1000)
  await Bun.write(unicode, `${UNICODE}\n\n${FIXTURES[1].text}\n\n${'Long paragraph '.repeat(20_000)}`)
  await Bun.write(malformed, 'not a zip')
  await archive(comic, [{ name: '001.png', blob: new Blob([new Uint8Array(small)]) }, { name: '002.png', blob: new Blob([Bun.file(large)]) }, { name: 'ComicInfo.xml', text: '<ComicInfo><Series>Gradient</Series><Title>Gradient</Title><Number>1</Number></ComicInfo>' }])
  await mkdir(join(folder, 'Chapter 1'), { recursive: true })
  await Bun.write(join(folder, 'Chapter 1', '001.png'), small)
  const digest = createHash('sha256').update(JSON.stringify(FIXTURES))
  for (const path of [novel, unicode, many, comic, malformed, image, large, join(folder, 'Chapter 1', '001.png')]) digest.update(new Uint8Array(await Bun.file(path).arrayBuffer()))
  const hash = digest.digest('hex')
  await Bun.write(join(root, 'canonical-outputs.json'), JSON.stringify({ models: MODELS, fixtures: FIXTURES, hash }, null, 2))
  return { root, novel, unicode, many, comic, folder, malformed, image, large, hash }
}
