import { parseDocument } from '../../text/document'
/**
 * EPUB package parsing, shared by the web reader (zip.js) and the native one
 * (fflate): both hand it a text reader over the archive's entries.
 *
 * EPUB 2 and 3 differ in where the cover is declared and in whether the spine
 * carries a table of contents, so both forms are probed. Encryption, media
 * overlays and fixed layout are ignored: they describe presentation this
 * reader does not offer.
 */

export interface EpubChapter {
  /** Zip entry path, already resolved against the package file's folder. */
  href: string
  /** Title from the table of contents, when the book supplies one. */
  title?: string
}

export interface EpubBook {
  title?: string
  author?: string
  description?: string
  language?: string
  chapters: EpubChapter[]
  /** Zip path of the cover image, when one is declared. */
  coverHref?: string
}

export const CONTAINER_PATH = 'META-INF/container.xml'

// ------------------------------------------------------------------ parsing --

function parseXml(xml: string, label: string): Document {
  const doc = parseDocument(xml, 'application/xml')
  if (doc.querySelector('parsererror')) {
    throw new Error(`This EPUB's ${label} is not valid XML.`)
  }
  return doc
}

export function rootfilePath(containerXml: string): string | null {
  const doc = parseXml(containerXml, 'container.xml')
  // Namespace-agnostic: `getElementsByTagName` on a namespaced document is
  // unreliable across parsers, and attribute lookup by local name is not.
  for (const element of [...doc.getElementsByTagName('*')]) {
    if (localName(element) !== 'rootfile') continue
    const path = element.getAttribute('full-path')
    if (path) return path
  }
  return null
}

export async function parsePackage(
  packageXml: string,
  packagePath: string,
  byPath: Map<string, unknown>,
  readText: (path: string) => Promise<string | null>,
): Promise<EpubBook> {
  const doc = parseXml(packageXml, 'package document')
  const base = directoryOf(packagePath)

  const elements = [...doc.getElementsByTagName('*')]
  const find = (name: string) =>
    elements.filter((element) => localName(element) === name)

  /** Manifest id to its resolved zip path and declared media type. */
  const manifest = new Map<string, { href: string; type: string; properties: string }>()
  for (const item of find('item')) {
    const id = item.getAttribute('id')
    const href = item.getAttribute('href')
    if (!id || !href) continue
    manifest.set(id, {
      href: resolve(base, href),
      type: item.getAttribute('media-type') ?? '',
      properties: item.getAttribute('properties') ?? '',
    })
  }

  const titles = find('title').map((node) => node.textContent?.trim() ?? '')
  const creators = find('creator').map((node) => node.textContent?.trim() ?? '')
  const descriptions = find('description').map(
    (node) => node.textContent?.trim() ?? '',
  )
  const languages = find('language').map((node) => node.textContent?.trim() ?? '')

  // Spine order is the reading order, and it is the only ordering that is
  // authoritative — manifest order and filename order both routinely disagree
  // with it.
  const spine: EpubChapter[] = []
  for (const ref of find('itemref')) {
    const idref = ref.getAttribute('idref')
    if (!idref) continue
    // `linear="no"` marks front matter the reader may skip, but a novel's
    // afterword is often marked this way too, so it is kept rather than lost.
    const item = manifest.get(idref)
    if (!item) continue
    if (item.type && !item.type.includes('html')) continue
    if (!byPath.has(normalise(item.href))) continue
    spine.push({ href: item.href })
  }

  applyTitles(spine, await tableOfContents(manifest, readText))

  return {
    title: titles.find(Boolean),
    author: creators.filter(Boolean).join(', ') || undefined,
    description: descriptions.find(Boolean),
    language: languages.find(Boolean),
    chapters: spine,
    coverHref: coverHref(find, manifest),
  }
}

/**
 * The cover image, declared one of three ways depending on the EPUB version.
 *
 * EPUB 3 marks the manifest item `properties="cover-image"`. EPUB 2 instead
 * points at it from a `<meta name="cover">`. Failing both, the first image in
 * the manifest is a serviceable guess for a novel, whose first image is almost
 * always its cover.
 */
function coverHref(
  find: (name: string) => Element[],
  manifest: Map<string, { href: string; type: string; properties: string }>,
): string | undefined {
  for (const item of manifest.values()) {
    if (item.properties.split(/\s+/).includes('cover-image')) return item.href
  }

  for (const meta of find('meta')) {
    if (meta.getAttribute('name') !== 'cover') continue
    const id = meta.getAttribute('content')
    const item = id ? manifest.get(id) : undefined
    if (item) return item.href
  }

  for (const item of manifest.values()) {
    if (item.type.startsWith('image/')) return item.href
  }
  return undefined
}

/** Chapter titles, from the EPUB 3 nav document or the EPUB 2 NCX. */
async function tableOfContents(
  manifest: Map<string, { href: string; type: string; properties: string }>,
  readText: (path: string) => Promise<string | null>,
): Promise<Map<string, string>> {
  const titles = new Map<string, string>()

  const navItem = [...manifest.values()].find((item) =>
    item.properties.split(/\s+/).includes('nav'),
  )
  const ncxItem = [...manifest.values()].find((item) =>
    item.type.includes('dtbncx'),
  )

  try {
    if (navItem) {
      const xml = await readText(navItem.href)
      if (xml) {
        const doc = parseDocument(xml, 'text/html')
        for (const anchor of [...doc.querySelectorAll('nav a[href]')]) {
          const href = anchor.getAttribute('href')
          const label = anchor.textContent?.trim()
          if (!href || !label) continue
          titles.set(
            normalise(stripFragment(resolve(directoryOf(navItem.href), href))),
            label,
          )
        }
      }
    } else if (ncxItem) {
      const xml = await readText(ncxItem.href)
      if (xml) {
        const doc = parseXml(xml, 'table of contents')
        for (const point of [...doc.getElementsByTagName('*')]) {
          if (localName(point) !== 'navPoint') continue
          const content = [...point.getElementsByTagName('*')].find(
            (node) => localName(node) === 'content',
          )
          const label = point.textContent?.trim()
          const href = content?.getAttribute('src')
          if (!href || !label) continue
          titles.set(
            normalise(stripFragment(resolve(directoryOf(ncxItem.href), href))),
            label,
          )
        }
      }
    }
  } catch {
    // A malformed table of contents costs chapter titles, not the book.
  }

  return titles
}

function applyTitles(spine: EpubChapter[], titles: Map<string, string>): void {
  if (titles.size === 0) return
  for (const chapter of spine) {
    const title = titles.get(normalise(chapter.href))
    if (title) chapter.title = title
  }
}

/**
 * The document body as an HTML fragment.
 *
 * Parsed as HTML rather than XML on purpose: XHTML that a strict XML parser
 * rejects is common in the wild, and an unreadable chapter is a worse outcome
 * than a leniently parsed one. Everything is sanitised downstream regardless.
 */
export function bodyOf(xml: string): string {
  const doc = parseDocument(xml, 'text/html')
  return doc.body?.innerHTML ?? ''
}

// ----------------------------------------------------------------- paths --

function localName(element: Element): string {
  return (element.localName || element.tagName).toLowerCase()
}

function directoryOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

/** Resolves a manifest href against the package file's folder. */
function resolve(base: string, href: string): string {
  const decoded = safeDecode(href)
  if (!base || decoded.startsWith('/')) return trimLeadingSlash(decoded)

  const segments = `${base}/${decoded}`.split('/')
  const out: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') out.pop()
    else out.push(segment)
  }
  return out.join('/')
}

/** Zip entries are byte-for-byte; hrefs are percent-encoded. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function stripFragment(path: string): string {
  const hash = path.indexOf('#')
  return hash === -1 ? path : path.slice(0, hash)
}

function trimLeadingSlash(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path
}

export function normalise(path: string): string {
  return trimLeadingSlash(safeDecode(path)).toLowerCase()
}
