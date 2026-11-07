import { parseDocument } from '@/lib/text/document'
import type { TextBlock } from '../protocol'

type ProseSpan = NonNullable<TextBlock['spans']>[number]
type InlineStyle = Omit<ProseSpan, 'text'>
interface Context { kind: 'paragraph' | 'heading' | 'quote' | 'code' | 'list'; level?: number; anchor?: string; prefix?: string; style: InlineStyle }

const BLOCKS: Readonly<Record<string, true>> = { P: true, DIV: true, BLOCKQUOTE: true, PRE: true, UL: true, OL: true, LI: true, FIGURE: true, FIGCAPTION: true, H1: true, H2: true, H3: true, H4: true, H5: true, H6: true, HR: true, IMG: true }

export function parseProse(html: string, sourceId: string, baseUrl?: string): TextBlock[] {
  const body = parseDocument(html, 'text/html').body
  const blocks: TextBlock[] = []
  const usedIds = new Set<string>()
  const add = (block: Omit<TextBlock, 'id'>, anchor?: string) => {
    let id = anchor || `text:${blocks.length}`
    while (usedIds.has(id)) id = `${id}:${blocks.length}`
    usedIds.add(id)
    blocks.push({ id, ...block })
  }
  const hrefOf = (href: string): string => {
    if (href.startsWith('#') || !baseUrl) return href
    try { return new URL(href, baseUrl).href } catch { return href }
  }
  const anchored = (from: number, anchor?: string) => {
    const first = blocks[from]
    if (anchor && first?.id.startsWith('text:') && !usedIds.has(anchor)) {
      usedIds.delete(first.id)
      first.id = anchor
      usedIds.add(anchor)
    }
  }

  const children = (parent: Element, context: Context): void => {
    let spans: ProseSpan[] = []
    let anchor = context.anchor
    let prefixUsed = false
    const flush = () => {
      if (spans.some((span) => span.text.trim())) {
        const prefix = !prefixUsed ? context.prefix : undefined
        const output = prefix ? [{ text: prefix }, ...spans] : spans
        add({ kind: context.kind, ...(context.level !== undefined ? { level: context.level } : {}), text: output.map((span) => span.text).join(''), spans: output }, anchor)
        anchor = undefined
        prefixUsed = true
      }
      spans = []
    }
    const inline = (node: Node, style: InlineStyle): void => {
      if (node.nodeType === 3) {
        const raw = node.nodeValue ?? ''
        const text = context.kind === 'code' ? raw : raw.replace(/[\t\n\r\f ]+/g, ' ')
        if (text) spans.push({ text, ...style })
        return
      }
      if (node.nodeType !== 1) return
      const element = node as Element
      const tag = element.tagName.toUpperCase()
      if (tag === 'BR') { spans.push({ text: '\n', ...style }); return }
      if (Object.hasOwn(BLOCKS, tag)) {
        flush()
        const from = blocks.length
        const listContent = context.kind === 'list' && tag !== 'UL' && tag !== 'OL' && tag !== 'IMG' && tag !== 'HR'
        block(element, { ...context, style, prefix: listContent && !prefixUsed ? context.prefix : undefined, anchor: element.getAttribute('id') || undefined })
        if (listContent && blocks.length > from) prefixUsed = true
        if (anchor) { anchored(from, anchor); anchor = undefined }
        return
      }
      if (!anchor) anchor = element.getAttribute('id') || undefined
      let next = style
      if (tag === 'B' || tag === 'STRONG') next = { ...style, bold: true }
      else if (tag === 'I' || tag === 'EM') next = { ...style, italic: true }
      else if (tag === 'CODE') next = { ...style, mono: true }
      else if (tag === 'U') next = { ...style, underline: true }
      else if (tag === 'A') {
        const href = element.getAttribute('href')
        if (href) next = { ...style, href: hrefOf(href) }
      }
      for (const child of [...element.childNodes]) inline(child, next)
    }
    for (const child of [...parent.childNodes]) inline(child, context.style)
    flush()
  }

  const block = (element: Element, inherited: Context): void => {
    const tag = element.tagName.toUpperCase()
    const anchor = element.getAttribute('id') || inherited.anchor
    if (tag === 'IMG') {
      const raw = element.getAttribute('src')
      if (raw) {
        let url = raw
        if (baseUrl) { try { url = new URL(raw, baseUrl).href } catch {} }
        add({ kind: 'image', imageRef: { sourceId, url }, text: element.getAttribute('alt') ?? '' }, anchor)
      }
      return
    }
    if (tag === 'HR') { add({ kind: 'rule' }, anchor); return }
    if (tag === 'UL' || tag === 'OL') {
      let ordinal = 0
      const before = blocks.length
      for (const item of [...element.children]) {
        if (item.tagName.toUpperCase() !== 'LI') continue
        ordinal++
        children(item, { kind: 'list', level: inherited.kind === 'list' ? (inherited.level ?? 0) + 1 : 0, anchor: item.getAttribute('id') || undefined, prefix: tag === 'OL' ? `${ordinal}. ` : '• ', style: inherited.style })
      }
      anchored(before, anchor)
      return
    }
    const before = blocks.length
    if (/^H[1-6]$/.test(tag)) children(element, { ...inherited, kind: 'heading', level: Number(tag[1]), anchor })
    else if (tag === 'PRE') children(element, { ...inherited, kind: 'code', anchor })
    else if (tag === 'BLOCKQUOTE') children(element, { ...inherited, kind: 'quote', anchor })
    else children(element, { ...inherited, kind: inherited.kind === 'quote' ? 'quote' : inherited.kind === 'code' ? 'code' : inherited.kind === 'list' ? 'list' : 'paragraph', anchor })
    anchored(before, anchor)
  }

  children(body, { kind: 'paragraph', style: {} })
  return blocks
}
