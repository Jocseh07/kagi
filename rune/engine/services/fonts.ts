import { createHash } from 'node:crypto'
import { readdir, lstat, rename, rm, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve } from 'node:path'
import { FONTS } from '../../../src/lib/fonts/model'
import { GOOGLE_FONT_PREFIX, normalizeFontName, googleFontsHref } from '../../../src/lib/fonts/custom'
import { getPreference, setPreference } from '../adapters/preferences'
import { ensureDirectory, isMissing } from '../adapters/storage'

export interface NativeFont { id: string; name: string; paths: string[] }
interface CustomFont { id: string; name: string; files: string[] }
const CATALOGUE_KEY = 'native.fonts'
let root: string | undefined
let assets: string | undefined
let mutation: Promise<unknown> = Promise.resolve()

export function configureFonts(dataRoot: string, assetsRoot = resolve(import.meta.dir, '../..')): void {
  root = resolve(dataRoot, 'fonts')
  assets = resolve(assetsRoot, 'fonts')
}
function roots(): { root: string; assets: string } {
  if (!root || !assets) throw new Error('Configure settings before loading fonts.')
  return { root, assets }
}
function directoryFor(id: string): string { return join(roots().root, createHash('sha256').update(id).digest('hex')) }
async function customFonts(): Promise<CustomFont[]> {
  const raw = await getPreference(CATALOGUE_KEY)
  if (!raw) return []
  const data: unknown = JSON.parse(raw)
  if (!Array.isArray(data)) throw new Error('The installed font catalogue is invalid.')
  return data.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || !('name' in entry) || typeof entry.name !== 'string' || !('id' in entry) || typeof entry.id !== 'string' || entry.id !== GOOGLE_FONT_PREFIX + entry.name || !normalizeFontName(entry.name) || !('files' in entry) || !Array.isArray(entry.files) || !entry.files.every((file: unknown) => typeof file === 'string' && /^\d+\.(woff2?|ttf|otf)$/.test(file))) throw new Error('The installed font catalogue is invalid.')
    return { id: entry.id, name: entry.name, files: entry.files as string[] }
  })
}
async function bundledFonts(): Promise<NativeFont[]> {
  let files: string[]
  try { files = await readdir(roots().assets) } catch (error) { if (!isMissing(error)) throw error; files = [] }
  return [...FONTS, { id: 'comic-neue', name: 'Comic Neue' }].map(({ id, name }) => ({
    id, name, paths: files.filter((file) => file.startsWith(`${id}-latin-`) && /\.(woff2?|ttf|otf)$/.test(file)).sort().map((file) => join(roots().assets, file)),
  }))
}
export async function fontCatalogue(): Promise<NativeFont[]> {
  const [bundled, custom] = await Promise.all([bundledFonts(), customFonts()])
  return [...bundled.filter((font) => font.id !== 'comic-neue'), ...custom.map((font) => ({ id: font.id, name: font.name, paths: font.files.map((file) => join(directoryFor(font.id), file)) }))]
}
export async function installedFontFiles(): Promise<{ family: string; path: string }[]> {
  const [bundled, custom] = await Promise.all([bundledFonts(), customFonts()])
  const fonts = [...bundled, ...custom.map((font) => ({ id: font.id, name: font.name, paths: font.files.map((file) => join(directoryFor(font.id), file)) }))]
  return fontFiles(fonts)
}
export async function bundledFontFiles(): Promise<{ family: string; path: string }[]> {
  return fontFiles(await bundledFonts())
}
async function fontFiles(fonts: NativeFont[]): Promise<{ family: string; path: string }[]> {
  const result: { family: string; path: string }[] = []
  for (const font of fonts) for (const path of font.paths) {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Font file is unavailable: ${font.name}. Reinstall it.`)
    result.push({ family: font.name, path })
  }
  return result
}
export async function readerFontFamily(id: string): Promise<string | undefined> {
  if (!id) return undefined
  const font = (await fontCatalogue()).find((entry) => entry.id === id)
  if (!font || !font.paths.length) throw new Error('The reader font is missing. Install it in Settings, Appearance.')
  for (const path of font.paths) {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('The reader font is unavailable. Reinstall it in Settings, Appearance.')
  }
  return font.name
}
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutation.then(fn)
  mutation = next.then(() => undefined, () => undefined)
  return next
}
function fontExtension(bytes: Uint8Array): string {
  const signature = new TextDecoder().decode(bytes.subarray(0, 4))
  if (signature === 'wOF2') return 'woff2'
  if (signature === 'wOFF') return 'woff'
  if (signature === 'OTTO') return 'otf'
  if (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) return 'ttf'
  throw new Error('Google Fonts returned an invalid font file.')
}
async function downloadFont(url: string, directory: string, index: number): Promise<string> {
  const pending = join(directory, `${index}.pending`)
  const file = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const header = new Uint8Array(4)
  let headerSize = 0
  let name: string
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'error' })
    if (!response.ok) throw new Error(`Font download failed (${response.status}). Try again.`)
    if (!response.body) throw new Error('The font download was empty.')
    reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const take = Math.min(4 - headerSize, value.byteLength)
      if (take > 0) { header.set(value.subarray(0, take), headerSize); headerSize += take }
      let offset = 0
      while (offset < value.byteLength) {
        const written = await file.write(value, offset, value.byteLength - offset)
        if (!written.bytesWritten) throw new Error('The font file could not be written.')
        offset += written.bytesWritten
      }
    }
    if (headerSize < 4) throw new Error('The font download was incomplete.')
    name = `${index}.${fontExtension(header)}`
    await file.sync()
  } finally {
    try { await reader?.cancel() }
    finally { reader?.releaseLock(); await file.close() }
  }
  await rename(pending, join(directory, name))
  return name
}
export async function installGoogleFont(input: string): Promise<NativeFont> {
  return serialize(async () => {
    const normalized = normalizeFontName(input)
    if (!normalized) throw new Error('Enter a Google font family name (2-60 letters or digits).')
    const saved = await customFonts()
    const existing = saved.find((font) => font.name.toLowerCase() === normalized.toLowerCase())
    if (existing) {
      const paths = existing.files.map((file) => join(directoryFor(existing.id), file))
      try {
        const files = await Promise.all(paths.map((path) => lstat(path)))
        if (files.every((file) => file.isFile() && !file.isSymbolicLink() && file.size >= 4)) return { id: existing.id, name: existing.name, paths }
      } catch (error) { if (!isMissing(error)) throw error }
    }
    let css: string | undefined
    let name = normalized
    for (const candidate of [...new Set([normalized, normalized.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())])]) {
      for (const axes of ['ital,wght@0,400;0,700;1,400', 'wght@400;700', '']) {
        const response = await fetch(googleFontsHref(candidate, axes), { signal: AbortSignal.timeout(30_000) })
        if (response.status === 400) continue
        if (!response.ok) throw new Error(`Google Fonts answered ${response.status}. Try again.`)
        css = await response.text()
        name = candidate
        break
      }
      if (css) break
    }
    if (!css) throw new Error('Google Fonts could not find that family.')
    const urls = [...new Set([...css.matchAll(/url\(\s*['"]?(https:[^)'"\s]+)['"]?\s*\)/g)].map((match) => match[1]))]
    if (!urls.length) throw new Error('Google Fonts returned an invalid stylesheet.')
    for (const url of urls) { const parsed = new URL(url); if (parsed.hostname !== 'fonts.gstatic.com' || parsed.protocol !== 'https:') throw new Error('Google Fonts returned an untrusted font URL.') }
    const id = GOOGLE_FONT_PREFIX + name
    const target = directoryFor(id)
    const temporary = `${target}.${crypto.randomUUID()}.staging`
    const files: string[] = []
    await ensureDirectory(temporary)
    try {
      for (const [index, url] of urls.entries()) files.push(await downloadFont(url, temporary, index))
      const old = `${target}.${crypto.randomUUID()}.previous`
      let moved = false
      try { await rename(target, old); moved = true } catch (error) { if (!isMissing(error)) throw error }
      try {
        await rename(temporary, target)
        await setPreference(CATALOGUE_KEY, JSON.stringify([...saved.filter((font) => font.id !== id && font.id !== existing?.id), { id, name, files }]))
      } catch (error) {
        await rm(target, { recursive: true, force: true })
        if (moved) await rename(old, target)
        throw error
      }
      if (moved) await rm(old, { recursive: true, force: true })
      return { id, name, paths: files.map((file) => join(target, file)) }
    } finally { await rm(temporary, { recursive: true, force: true }) }
  })
}
export async function removeGoogleFont(id: string): Promise<void> {
  return serialize(async () => {
    const saved = await customFonts()
    if (!saved.some((font) => font.id === id)) throw new Error('That custom font is not installed.')
    await setPreference(CATALOGUE_KEY, JSON.stringify(saved.filter((font) => font.id !== id)))
    await rm(directoryFor(id), { recursive: true, force: true })
  })
}
export async function clearFontCache(): Promise<void> {
  return serialize(async () => {
    const keep = new Set((await customFonts()).map((font) => createHash('sha256').update(font.id).digest('hex')))
    let entries: string[]
    try { entries = await readdir(roots().root) } catch (error) { if (isMissing(error)) return; throw error }
    for (const entry of entries) if (!keep.has(entry)) await rm(join(roots().root, entry), { recursive: true, force: true })
  })
}
