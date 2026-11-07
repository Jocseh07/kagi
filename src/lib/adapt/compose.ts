import { createCanvas, createCanvasPath, drawCanvasImage, loadCanvasFonts, loadCanvasImage, releaseCanvasImage } from './canvas'
import type { CanvasContext, CanvasImage } from './canvas'
import { LAYOUTS, PAGE_H, PAGE_W, STRIP_W, stripRects } from './layouts'
import type { Align, Frame, Gap, Rect } from './layouts'
import type { TiersLayout } from './layouts'
import type { StripTone, TextItem } from './store'

export type LetteredText = TextItem & {
  /** The speaker's first name, on their first line in the chapter only. */
  tag?: string
}

export interface StripPanel {
  image: Blob
  text: readonly LetteredText[]
  frame: Frame
  gapAfter?: Gap
  align?: Align
}

const REF_SIZE = 768
const FONT = 'Inter, ui-sans-serif, system-ui, sans-serif'
const LETTERING_FONT = `'Comic Neue', ${FONT}`
const LINE_HEIGHT = 1.25
const OVAL_GROW = { w: 1.35, h: 1.45 }
const TAG_SCALE = 0.6
const TAIL_SCALE = 1.5
/** Half the tail's width where it meets the oval, in radians. */
const TAIL_SPREAD = 0.22
const CELL = 16
/** How far a webtoon bubble may sit outside its panel, into the gutter. */
const STRADDLE_REACH = 360
/** The share of a straddling bubble that must still overlap its own panel. */
const MIN_INSIDE = 0.15
/** Bubble widths tried, as shares of the widest allowed. */
const WIDTH_STEPS = [1, 0.75, 0.55] as const
/** Cost of drifting from the script's anchor corner, against average image detail. */
const DRIFT_WEIGHT = 0.4
const BUBBLE_GAP = 12

interface Lettering {
  text: number
  sfx: number
  pad: number
  edge: number
  /** Widest bubble, as a share of the panel width. */
  widthShare: number
  maxWidth: number
  /** Bubbles cross the panel edge into the gutter, as webtoons letter them. */
  straddle: boolean
}

const PAGE_LETTERING: Lettering = { text: 28, sfx: 96, pad: 22, edge: 18, widthShare: 0.46, maxWidth: 520, straddle: false }
// Sized against a 1200 px strip so lettering still reads on a phone.
const STRIP_LETTERING: Lettering = { text: 40, sfx: 120, pad: 28, edge: 40, widthShare: 0.6, maxWidth: 720, straddle: true }

// Lettering is part of the drawn page, not the app's chrome, so it uses print
// colours rather than theme tokens and reads the same in light and dark mode.
const INK = '#000000'
const PAPER = '#ffffff'
const CAPTION_FILL = 'rgba(20, 20, 28, 0.9)'
const SFX_FILL = '#ffd23f'
const GUTTERS: Record<StripTone, string> = { light: '#ffffff', dark: '#1c1c22' }


/** Shrinks a reference sheet so it costs fewer input tokens. */
export async function downscale(blob: Blob, max = REF_SIZE): Promise<Blob> {
  const bitmap = await loadCanvasImage(blob)
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height))
  const canvas = createCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
  drawCanvasImage(canvas.getContext('2d')!, bitmap, 0, 0, canvas.width, canvas.height)
  releaseCanvasImage(bitmap)
  return canvas.convertToBlob({ type: 'image/png' })
}

/** Several references side by side, for a backend that takes only one image. */
export async function contactSheet(blobs: readonly Blob[]): Promise<Blob> {
  const bitmaps = await Promise.all(blobs.map((blob) => loadCanvasImage(blob)))
  const widths = bitmaps.map((bitmap) => Math.round((bitmap.width * REF_SIZE) / bitmap.height))
  const canvas = createCanvas(widths.reduce((sum, width) => sum + width, 0), REF_SIZE)
  const ctx = canvas.getContext('2d')!
  let x = 0
  bitmaps.forEach((bitmap, index) => {
    drawCanvasImage(ctx, bitmap, x, 0, widths[index], REF_SIZE)
    x += widths[index]
    releaseCanvasImage(bitmap)
  })
  return canvas.convertToBlob({ type: 'image/png' })
}

function wrap(ctx: CanvasContext, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line)
      line = word
    } else {
      line = next
    }
  }
  if (line) lines.push(line)
  return lines
}

/** Captions are narration in the body face; speech and thought are hand-lettered. */
function textFont(caption: boolean, size: number): string {
  return caption ? `400 ${size}px ${FONT}` : `700 ${size}px ${LETTERING_FONT}`
}

function bubbleSize(ctx: CanvasContext, item: TextItem, maxWidth: number, metrics: Lettering) {
  const { text: size, sfx, pad } = metrics
  if (item.kind === 'sfx') {
    ctx.font = `700 ${sfx}px ${FONT}`
    return { lines: [item.line], w: ctx.measureText(item.line).width + pad, h: sfx * 1.1 }
  }
  const caption = item.kind === 'caption'
  // An oval needs room around the text block for its curve.
  const grow = caption ? { w: 1, h: 1 } : OVAL_GROW
  ctx.font = textFont(caption, size)
  const lines = wrap(ctx, item.line, (maxWidth - pad * 2) / grow.w)
  const textWidth = Math.max(...lines.map((line) => ctx.measureText(line).width))
  return { lines, w: textWidth * grow.w + pad * 2, h: lines.length * size * LINE_HEIGHT * grow.h + pad * 2 }
}

interface Point {
  x: number
  y: number
}

const SPEAKER_X = { left: 0.25, center: 0.5, right: 0.75 } as const

/** The point a tail aims at: the speaker's side of the panel, or straight out past the nearest edge. */
function tailTarget(rect: Rect, item: TextItem, center: Point): Point | null {
  if (!item.speakerAt) return null
  if (item.speakerAt === 'off') {
    const towardLeft = center.x < rect.x + rect.w / 2
    return { x: towardLeft ? rect.x - rect.w : rect.x + rect.w * 2, y: center.y }
  }
  return { x: rect.x + rect.w * SPEAKER_X[item.speakerAt], y: rect.y + rect.h * 0.4 }
}

function edgeAt(center: Point, rx: number, ry: number, angle: number, scale = 1): Point {
  return { x: center.x + rx * scale * Math.cos(angle), y: center.y + ry * scale * Math.sin(angle) }
}

function speechBubble(ctx: CanvasContext, center: Point, rx: number, ry: number, target: Point | null, length: number) {
  const oval = createCanvasPath()
  oval.ellipse(center.x, center.y, rx, ry, 0, 0, Math.PI * 2)
  const shapes = [oval]
  if (target) {
    const angle = Math.atan2(target.y - center.y, target.x - center.x)
    const edge = edgeAt(center, rx, ry, angle)
    const tail = createCanvasPath()
    const from = edgeAt(center, rx, ry, angle - TAIL_SPREAD, 0.8)
    const to = edgeAt(center, rx, ry, angle + TAIL_SPREAD, 0.8)
    tail.moveTo(from.x, from.y)
    tail.lineTo(edge.x + Math.cos(angle) * length, edge.y + Math.sin(angle) * length)
    tail.lineTo(to.x, to.y)
    tail.closePath()
    shapes.push(tail)
  }
  // Every outline first, then every fill, so the tail joins the oval without a seam.
  for (const shape of shapes) ctx.stroke(shape)
  for (const shape of shapes) ctx.fill(shape)
}

/** A plain oval with a dotted outline and no tail; the name tag and placement say who thinks it. */
function thoughtBubble(ctx: CanvasContext, center: Point, rx: number, ry: number) {
  const oval = createCanvasPath()
  oval.ellipse(center.x, center.y, rx, ry, 0, 0, Math.PI * 2)
  ctx.fill(oval)
  ctx.lineCap = 'round'
  ctx.setLineDash([0, ctx.lineWidth * 2.5])
  ctx.stroke(oval)
}

interface DetailMap {
  x: number
  y: number
  cols: number
  rows: number
  sums: Float64Array
  mean: number
}

/** Summed-area table of luminance gradient per cell: faces and hair score high, sky, walls and gutter near zero. */
function detailMap(ctx: CanvasContext, area: Rect): DetailMap {
  const x = Math.floor(area.x)
  const y = Math.floor(area.y)
  const cols = Math.max(1, Math.floor(area.w / CELL))
  const rows = Math.max(1, Math.floor(area.h / CELL))
  const width = cols * CELL
  const height = rows * CELL
  const { data } = ctx.getImageData(x, y, width, height)
  const lum = (px: number, py: number) => {
    const i = (py * width + px) * 4
    return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
  }
  const sums = new Float64Array((cols + 1) * (rows + 1))
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let detail = 0
      for (let py = r * CELL; py < (r + 1) * CELL; py += 2) {
        for (let px = c * CELL; px < (c + 1) * CELL - 2; px += 2) {
          const value = lum(px, py)
          detail += Math.abs(value - lum(px + 2, py)) + Math.abs(value - lum(px, Math.min(py + 2, height - 1)))
        }
      }
      sums[(r + 1) * (cols + 1) + c + 1] = detail + sums[r * (cols + 1) + c + 1] + sums[(r + 1) * (cols + 1) + c] - sums[r * (cols + 1) + c]
    }
  }
  return { x, y, cols, rows, sums, mean: sums[sums.length - 1] / (cols * rows) || 1 }
}

/** Total detail under a box: a face costs the same whether the rest of the bubble sits on gutter or not. */
function detailIn(map: DetailMap, box: Rect): number {
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value))
  const c0 = clamp(Math.floor((box.x - map.x) / CELL), map.cols)
  const c1 = clamp(Math.ceil((box.x + box.w - map.x) / CELL), map.cols)
  const r0 = clamp(Math.floor((box.y - map.y) / CELL), map.rows)
  const r1 = clamp(Math.ceil((box.y + box.h - map.y) / CELL), map.rows)
  if (c1 <= c0 || r1 <= r0) return 0
  const at = (r: number, c: number) => map.sums[r * (map.cols + 1) + c]
  return at(r1, c1) - at(r0, c1) - at(r1, c0) + at(r0, c0)
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

interface Spot extends Point {
  cost: number
}

/** The flattest spot for a bubble, near its anchor corner, clear of other bubbles and other panels. */
function clearSpot(
  map: DetailMap,
  size: { w: number; h: number },
  rect: Rect,
  preferred: Point,
  placed: readonly Rect[],
  others: readonly Rect[],
  bounds: Rect,
  minInside: number,
  /** Detail an average bubble-sized patch of this panel carries, so costs compare across bubble widths. */
  scale: number,
): Spot | null {
  const area = size.w * size.h
  const reach = Math.max(rect.w, rect.h)
  const taken = placed.map((p) => ({ x: p.x - BUBBLE_GAP, y: p.y - BUBBLE_GAP, w: p.w + BUBBLE_GAP * 2, h: p.h + BUBBLE_GAP * 2 }))
  let best: Spot | null = null
  for (let y = bounds.y; y + size.h <= bounds.y + bounds.h; y += CELL) {
    for (let x = bounds.x; x + size.w <= bounds.x + bounds.w; x += CELL) {
      const box = { x, y, w: size.w, h: size.h }
      if (overlap(box, rect) < minInside * area - 1) continue
      if (others.some((other) => overlap(box, other) > 0) || taken.some((other) => overlap(box, other) > 0)) continue
      const cost = detailIn(map, box) / scale + (DRIFT_WEIGHT * Math.hypot(x - preferred.x, y - preferred.y)) / reach
      if (!best || cost < best.cost) best = { x, y, cost }
    }
  }
  return best
}

function nameTag(ctx: CanvasContext, name: string, metrics: Lettering) {
  const size = Math.round(metrics.text * TAG_SCALE)
  ctx.font = `700 ${size}px ${LETTERING_FONT}`
  const label = name.toUpperCase()
  return { label, size, w: ctx.measureText(label).width + size * 1.4, h: size * 1.6 }
}

function bubbleTop(rect: Rect, top: boolean, h: number, stacked: number, metrics: Lettering, canvasHeight: number): number {
  if (!metrics.straddle) {
    return Math.max(rect.y, top ? rect.y + metrics.edge + stacked : rect.y + rect.h - h - metrics.edge - stacked)
  }
  const y = top ? rect.y - h * 0.4 + stacked : rect.y + rect.h - h * 0.6 - stacked
  return Math.min(Math.max(y, 0), canvasHeight - h)
}

function letter(
  ctx: CanvasContext,
  rect: Rect,
  text: readonly LetteredText[],
  metrics: Lettering,
  others: readonly Rect[] = [],
): void {
  const { text: size, sfx, edge } = metrics
  const maxWidth = Math.min(metrics.maxWidth, Math.round(rect.w * metrics.widthShare))
  const canvas = ctx.canvas
  const reachTop = Math.max(0, rect.y - STRADDLE_REACH)
  const bounds = metrics.straddle
    ? { x: 0, y: reachTop, w: canvas.width, h: Math.min(canvas.height, rect.y + rect.h + STRADDLE_REACH) - reachTop }
    : { x: rect.x + edge, y: rect.y + edge, w: rect.w - edge * 2, h: rect.h - edge * 2 }
  // Read before this panel is lettered, so its own bubbles do not count as detail.
  const map = detailMap(ctx, bounds)
  const placed: Rect[] = []
  const stack = { tl: 0, tr: 0, bl: 0, br: 0 }

  for (const raw of text) {
    const spoken = raw.kind === 'speech' || raw.kind === 'thought'
    // Webtoon dialogue is lettered in capitals; captions keep the novel's case.
    const item = spoken ? { ...raw, line: raw.line.toUpperCase() } : raw
    const tag = spoken && item.tag ? nameTag(ctx, item.tag, metrics) : null
    const lift = tag ? tag.h / 2 : 0
    const left = item.anchor.endsWith('l')
    const top = item.anchor.startsWith('t')
    // Narrower, taller bubbles fit beside a head where a wide one would cover it.
    const shapes = (item.kind === 'sfx' ? [1] : WIDTH_STEPS).map((step) => {
      const shape = bubbleSize(ctx, item, Math.round(maxWidth * step), metrics)
      const preferred = {
        x: left ? rect.x + edge : rect.x + rect.w - shape.w - edge,
        y: bubbleTop(rect, top, shape.h + lift, stack[item.anchor], metrics, canvas.height),
      }
      return { ...shape, preferred }
    })
    const scale = map.mean * Math.max(1, (shapes[0].w * (shapes[0].h + lift)) / (CELL * CELL))
    // A sound effect belongs on the action; everything else moves off faces onto flat ground or gutter.
    const choice =
      item.kind === 'sfx'
        ? { ...shapes[0], spot: shapes[0].preferred }
        : (shapes
            .flatMap((shape) => {
              const box = { w: shape.w, h: shape.h + lift }
              const spot = clearSpot(map, box, rect, shape.preferred, placed, others, bounds, metrics.straddle ? MIN_INSIDE : 1, scale)
              return spot ? [{ ...shape, spot }] : []
            })
            .sort((a, b) => a.spot.cost - b.spot.cost)[0] ?? { ...shapes[0], spot: shapes[0].preferred })
    const { lines, w, h, spot } = choice
    stack[item.anchor] += h + lift + BUBBLE_GAP
    placed.push({ x: spot.x, y: spot.y, w, h: h + lift })
    const x = spot.x
    const y = spot.y + lift

    ctx.save()
    ctx.textBaseline = 'top'
    ctx.textAlign = 'center'
    if (item.kind === 'sfx') {
      ctx.font = `700 ${sfx}px ${FONT}`
      ctx.lineWidth = 6
      ctx.strokeStyle = INK
      ctx.fillStyle = SFX_FILL
      ctx.strokeText(item.line, x + w / 2, y)
      ctx.fillText(item.line, x + w / 2, y)
      ctx.restore()
      continue
    }

    const caption = !spoken
    const center = { x: x + w / 2, y: y + h / 2 }
    if (caption) {
      ctx.beginPath()
      ctx.roundRect(x, y, w, h, 4)
      ctx.fillStyle = CAPTION_FILL
      ctx.fill()
      ctx.lineWidth = 3
      ctx.strokeStyle = PAPER
      ctx.stroke()
    } else {
      // Outlines are drawn double width and half covered by the fill: a thin ink line, as lettered webtoons use.
      ctx.lineWidth = 4
      ctx.strokeStyle = INK
      ctx.fillStyle = PAPER
      if (item.kind === 'speech') speechBubble(ctx, center, w / 2, h / 2, tailTarget(rect, item, center), size * TAIL_SCALE)
      else thoughtBubble(ctx, center, w / 2, h / 2)
    }

    ctx.font = textFont(caption, size)
    ctx.fillStyle = caption ? PAPER : INK
    const textTop = center.y - (lines.length * size * LINE_HEIGHT) / 2
    lines.forEach((line, index) => ctx.fillText(line, center.x, textTop + index * size * LINE_HEIGHT))

    if (tag) {
      const tagX = x + Math.min(w * 0.12, w - tag.w)
      const tagY = Math.max(0, y - tag.h / 2)
      ctx.beginPath()
      ctx.roundRect(tagX, tagY, tag.w, tag.h, tag.h / 2)
      ctx.fillStyle = INK
      ctx.fill()
      ctx.font = `700 ${tag.size}px ${LETTERING_FONT}`
      ctx.fillStyle = PAPER
      ctx.textBaseline = 'middle'
      ctx.fillText(tag.label, tagX + tag.w / 2, tagY + tag.h / 2)
    }
    ctx.restore()
  }
}

function drawCover(ctx: CanvasContext, bitmap: CanvasImage, rect: Rect): void {
  const scale = Math.max(rect.w / bitmap.width, rect.h / bitmap.height)
  const sw = rect.w / scale
  const sh = rect.h / scale
  drawCanvasImage(ctx, bitmap, (bitmap.width - sw) / 2, (bitmap.height - sh) / 2, sw, sh, rect.x, rect.y, rect.w, rect.h)
}

export async function composePage(
  layout: TiersLayout,
  panels: readonly { image: Blob; text: readonly LetteredText[] }[],
): Promise<Blob> {
  await loadCanvasFonts()
  const canvas = createCanvas(PAGE_W, PAGE_H)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, PAGE_W, PAGE_H)

  const rects = LAYOUTS[layout]
  for (const [index, panel] of panels.entries()) {
    const rect = rects[index]
    const bitmap = await loadCanvasImage(panel.image)
    ctx.save()
    ctx.beginPath()
    ctx.rect(rect.x, rect.y, rect.w, rect.h)
    ctx.clip()
    drawCover(ctx, bitmap, rect)
    letter(ctx, rect, panel.text, PAGE_LETTERING)
    ctx.restore()
    releaseCanvasImage(bitmap)

    ctx.lineWidth = 4
    ctx.strokeStyle = INK
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h)
  }

  return canvas.convertToBlob({ type: 'image/webp', quality: 0.85 })
}

/** A borderless webtoon segment: whole panels on a gutter colour, lettered after every image so bubbles can cross edges. */
export async function composeStrip(tone: StripTone, panels: readonly StripPanel[]): Promise<Blob> {
  await loadCanvasFonts()
  const bitmaps = await Promise.all(panels.map((panel) => loadCanvasImage(panel.image)))
  const { rects, height } = stripRects(
    panels.map((panel, index) => ({
      frame: panel.frame,
      aspect: bitmaps[index].height / bitmaps[index].width,
      gapAfter: panel.gapAfter,
      align: panel.align,
    })),
  )
  const canvas = createCanvas(STRIP_W, height)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = GUTTERS[tone]
  ctx.fillRect(0, 0, STRIP_W, height)

  bitmaps.forEach((bitmap, index) => {
    const rect = rects[index]
    drawCanvasImage(ctx, bitmap, rect.x, rect.y, rect.w, rect.h)
    releaseCanvasImage(bitmap)
  })
  for (const [index, panel] of panels.entries()) {
    letter(ctx, rects[index], panel.text, STRIP_LETTERING, rects.filter((_, other) => other !== index))
  }

  return canvas.convertToBlob({ type: 'image/webp', quality: 0.85 })
}
