/**
 * Allowlist sanitiser for novel chapter HTML.
 *
 * Chapter bodies are third-party input that ends up in `dangerouslySetInnerHTML`,
 * so nothing may reach the reader unfiltered. This is an allowlist rather than a
 * blocklist on purpose: an unknown element is dropped, not permitted, which is
 * the only form that stays safe as the input changes.
 *
 * `DOMParser` builds the tree in an inert document — no script runs, no image
 * loads, no fetch is issued while parsing — so it is safe to inspect the very
 * markup being vetted.
 */

/** Elements kept, with the attributes each may carry. Everything else goes. */
const ALLOWED: Record<string, readonly string[]> = {
  P: [],
  BR: [],
  HR: [],
  EM: [],
  I: [],
  STRONG: [],
  B: [],
  U: [],
  S: [],
  SUP: [],
  SUB: [],
  SPAN: [],
  DIV: [],
  BLOCKQUOTE: [],
  PRE: [],
  CODE: [],
  H1: [],
  H2: [],
  H3: [],
  H4: [],
  H5: [],
  H6: [],
  UL: [],
  OL: [],
  LI: [],
  FIGURE: [],
  FIGCAPTION: [],
  A: ['href', 'title'],
  IMG: ['src', 'alt', 'width', 'height'],
}

/** Attributes carrying a URL, checked against the scheme allowlist below. */
const URL_ATTRIBUTES = new Set(['href', 'src'])

/**
 * Schemes permitted in a URL attribute.
 *
 * `javascript:` is the obvious exclusion, but `data:` is excluded too: a
 * `data:text/html` document in an `<a href>` navigates to attacker-controlled
 * markup on this origin.
 */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

/**
 * Elements dropped whole, contents included.
 *
 * The rest of the walk unwraps a rejected element and keeps its children, which
 * is right for a stray `<font>` around a paragraph but catastrophic for these:
 * the text inside a `<script>` is the payload.
 */
const DROP_WITH_CONTENTS = new Set([
  'SCRIPT',
  'STYLE',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'TEMPLATE',
  'NOSCRIPT',
  'FORM',
  'INPUT',
  'BUTTON',
  'SELECT',
  'TEXTAREA',
  'LINK',
  'META',
  'BASE',
  'SVG',
  'MATH',
])

export interface SanitizedText {
  html: string
  /** Plain-text length of the result, for reading estimates and saved size. */
  textLength: number
}

/**
 * Cleans a chapter fragment and measures it.
 *
 * Returns both halves together because the text length has to be taken from the
 * *sanitised* tree — measuring the input would count markup that never reaches
 * the reader.
 */
export function sanitizeChapterHtml(html: string): SanitizedText {
  if (typeof DOMParser === 'undefined') {
    // No DOM (the smoke scripts run in Node). Refusing to guess is the safe
    // answer: returning the input unfiltered would defeat the entire module.
    const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    return { html: escapeHtml(text), textLength: text.length }
  }

  const body = new DOMParser().parseFromString(html, 'text/html').body
  clean(body)

  return {
    html: body.innerHTML,
    textLength: (body.textContent ?? '').replace(/\s+/g, ' ').trim().length,
  }
}

/**
 * Walks children in reverse so that unwrapping or removing a node cannot make
 * the walk skip its sibling.
 */
function clean(parent: Element): void {
  const children = [...parent.childNodes]
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const node = children[index]
    if (!node) continue

    if (node.nodeType === Node.TEXT_NODE) continue

    if (node.nodeType !== Node.ELEMENT_NODE) {
      // Comments and processing instructions carry nothing worth keeping.
      node.parentNode?.removeChild(node)
      continue
    }

    const element = node as Element
    const tag = element.tagName.toUpperCase()

    if (DROP_WITH_CONTENTS.has(tag)) {
      element.remove()
      continue
    }

    // Recurse before deciding this element's own fate: unwrapping it moves
    // children up, and they must already be clean when that happens.
    clean(element)

    const allowedAttributes = ALLOWED[tag]
    if (!allowedAttributes) {
      unwrap(element)
      continue
    }

    scrubAttributes(element, allowedAttributes)

    if (tag === 'A') {
      // A link that survived opens away from the app and must not hand the
      // target a referrer or a window handle back to this page.
      element.setAttribute('target', '_blank')
      element.setAttribute('rel', 'noopener noreferrer nofollow')
    }

    if (tag === 'IMG') {
      // Chapter illustrations are hotlinked from the source's own CDN, which
      // commonly rejects a request carrying this app's referrer.
      element.setAttribute('referrerpolicy', 'no-referrer')
      element.setAttribute('loading', 'lazy')
      element.setAttribute('decoding', 'async')
      // An <img> with no usable src renders as a broken-image glyph mid-prose.
      if (!element.getAttribute('src')) element.remove()
    }
  }
}

function scrubAttributes(element: Element, allowed: readonly string[]): void {
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase()

    if (!allowed.includes(name)) {
      element.removeAttribute(attribute.name)
      continue
    }

    if (URL_ATTRIBUTES.has(name) && !isSafeUrl(attribute.value)) {
      element.removeAttribute(attribute.name)
    }
  }
}

/**
 * True for a URL the reader may follow or load.
 *
 * Parsed against a base so that a relative path resolves rather than throwing.
 * A protocol-relative or absolute URL keeps its own scheme, which is what is
 * being checked; anything unparseable is refused.
 */
function isSafeUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  // Control characters are how `java\0script:` style bypasses are smuggled past
  // a naive scheme check; the URL parser strips some of them itself. Checked by
  // code point rather than by regex, which the linter flags for good reason.
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return false
  }

  try {
    const base =
      typeof location === 'undefined' ? 'https://invalid.example' : location.href
    return SAFE_SCHEMES.has(new URL(trimmed, base).protocol)
  } catch {
    return false
  }
}

/** Replaces an element with its (already cleaned) children. */
function unwrap(element: Element): void {
  const parent = element.parentNode
  if (!parent) return
  while (element.firstChild) parent.insertBefore(element.firstChild, element)
  parent.removeChild(element)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
