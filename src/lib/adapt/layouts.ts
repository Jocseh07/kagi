export const PAGE_W = 1600
export const PAGE_H = 2400
const MARGIN = 60
const GUTTER = 24

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

// Stacked full-width manga panels, cropped to fit. Strip frames ask the backend
// for their own shape (`IMAGE_SIZES`) and are placed whole.
function tiers(count: number): Rect[] {
  const w = PAGE_W - MARGIN * 2
  const h = Math.round((PAGE_H - MARGIN * 2 - GUTTER * (count - 1)) / count)
  return Array.from({ length: count }, (_, index) => ({
    x: MARGIN,
    y: MARGIN + index * (h + GUTTER),
    w,
    h,
  }))
}

export const LAYOUTS = {
  'tiers-2': tiers(2),
  'tiers-3': tiers(3),
} as const

export type TiersLayout = keyof typeof LAYOUTS

export type LayoutName = TiersLayout | 'strip'

export const LAYOUT_NAMES = [...Object.keys(LAYOUTS), 'strip'] as LayoutName[]

export function isLayoutName(value: unknown): value is LayoutName {
  return value === 'strip' || (typeof value === 'string' && value in LAYOUTS)
}

export const STRIP_W = 1200
const EDGE_GAP = 120

export type Frame = 'wide' | 'inset' | 'close' | 'tall'

export const FRAMES: readonly Frame[] = ['wide', 'inset', 'close', 'tall']

/** The size each frame is drawn at, so the strip places it whole instead of cropping. */
export const IMAGE_SIZES: Record<Frame, string> = {
  wide: '1536x1024',
  inset: '1536x1024',
  close: '1024x1024',
  tall: '1024x1536',
}

const FRAME_WIDTHS: Record<Frame, number> = { wide: STRIP_W, inset: 1000, close: 1000, tall: 900 }

export type Gap = 'tight' | 'normal' | 'pause' | 'reveal'

export const GAPS: Record<Gap, number> = { tight: 120, normal: 240, pause: 360, reveal: 560 }

export const ALIGNS = ['left', 'center', 'right'] as const

export type Align = (typeof ALIGNS)[number]

export function isFrame(value: unknown): value is Frame {
  return typeof value === 'string' && (FRAMES as readonly string[]).includes(value)
}

export function isGap(value: unknown): value is Gap {
  return typeof value === 'string' && value in GAPS
}

export interface StripSlot {
  frame: Frame
  /** The drawn image's height over its width. */
  aspect: number
  gapAfter?: Gap
  align?: Align
}

// Half the edge gap above and below, so segments stacked in the reader meet with a full gap.
export function stripRects(slots: readonly StripSlot[]): { rects: Rect[]; height: number } {
  let y = EDGE_GAP / 2
  const rects = slots.map((slot, index) => {
    const w = FRAME_WIDTHS[slot.frame]
    const h = Math.round(w * slot.aspect)
    const x = slot.align === 'left' ? 0 : slot.align === 'right' ? STRIP_W - w : Math.round((STRIP_W - w) / 2)
    const rect = { x, y, w, h }
    y += h + (index < slots.length - 1 ? GAPS[slot.gapAfter ?? 'normal'] : 0)
    return rect
  })
  const last = slots.at(-1)?.gapAfter
  return { rects, height: y + (last ? GAPS[last] : EDGE_GAP) / 2 }
}
