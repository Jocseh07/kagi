import { parseDocument } from './document'
export type WordStartStrength = 'light' | 'medium' | 'strong'

const FRACTION: Record<WordStartStrength, number> = {
  light: 0.3,
  medium: 0.45,
  strong: 0.6,
}

/** Already weighted, or must stay intact: a link or code split mid-word breaks. */
const SKIP_TAGS = new Set(['B', 'STRONG', 'A', 'CODE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'])

const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’]*/gu

// Scripts written without spaces have no word starts to mark.
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u

/** How many leading letters of a word are bolded. Never the whole word unless it is one letter. */
export function wordStartLength(word: string, strength: WordStartStrength): number {
  const length = [...word].length
  if (length <= 3) return 1
  return Math.min(length - 1, Math.max(1, Math.round(length * FRACTION[strength])))
}

/**
 * Bolds the start of every word in a sanitised chapter fragment.
 *
 * Runs at render, after `sanitizeChapterHtml`, so stored chapters and their
 * measured length never carry the extra markup.
 */
export function markWordStarts(html: string, strength: WordStartStrength): string {
  const document = parseDocument(html, 'text/html')
  const body = document.body
  const nodes: Text[] = []
  const visit = (parent: Node): void => {
    for (const node of parent.childNodes) {
      if (node.nodeType === 1) {
        if (!SKIP_TAGS.has((node as Element).tagName.toUpperCase())) visit(node)
      } else if (node.nodeType === 3) {
        const text = node.nodeValue ?? ''
        if (text.trim() && !UNSPACED.test(text)) nodes.push(node as Text)
      }
    }
  }
  visit(body)

  for (const node of nodes) {
    const text = node.nodeValue ?? ''
    const marked = document.createDocumentFragment()
    let last = 0
    for (const match of text.matchAll(WORD)) {
      const word = match[0]
      const chars = [...word]
      const cut = wordStartLength(word, strength)
      const start = document.createElement('b')
      start.dataset.wordStart = ''
      start.textContent = chars.slice(0, cut).join('')
      marked.append(text.slice(last, match.index), start, chars.slice(cut).join(''))
      last = match.index + word.length
    }
    if (last === 0) continue
    marked.append(text.slice(last))
    node.replaceWith(marked)
  }

  return body.innerHTML
}
