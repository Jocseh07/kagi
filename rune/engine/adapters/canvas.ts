import { createCanvas as skiaCanvas, GlobalFonts, loadImage, Path2D } from '@napi-rs/canvas'
import type { Canvas, Image, SKRSContext2D } from '@napi-rs/canvas'
import { createRequire } from 'node:module'

export type CanvasContext = SKRSContext2D
export interface CanvasImage {
  width: number
  height: number
  image: Image | null
}

export function createCanvas(width: number, height: number): Canvas {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`Invalid canvas dimensions: ${width} x ${height}.`)
  }
  return skiaCanvas(width, height)
}

export async function loadCanvasImage(blob: Blob): Promise<CanvasImage> {
  const image = await loadImage(new Uint8Array(await blob.arrayBuffer()))
  return { image, width: image.width, height: image.height }
}

export function releaseCanvasImage(image: CanvasImage): void {
  image.image = null
}

export function drawCanvasImage(ctx: CanvasContext, image: CanvasImage, x: number, y: number, w: number, h: number, dx?: number, dy?: number, dw?: number, dh?: number): void {
  if (!image.image) throw new Error('The canvas image has been released.')
  if (dx === undefined) ctx.drawImage(image.image, x, y, w, h)
  else ctx.drawImage(image.image, x, y, w, h, dx, dy!, dw!, dh!)
}

export function createCanvasPath(): Path2D {
  return new Path2D()
}

let fontsReady: Promise<void> | undefined
let fontPaths: { inter: string; comicNeue: string } | undefined

export function configureCanvasFonts(paths: { inter: string; comicNeue: string }): void {
  if (fontsReady) throw new Error('Configure canvas fonts before composing images.')
  fontPaths = paths
}

export function loadCanvasFonts(): Promise<void> {
  fontsReady ??= Promise.resolve().then(() => {
    const require = createRequire(import.meta.url)
    const paths = fontPaths ?? {
      inter: require.resolve('@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'),
      comicNeue: require.resolve('@fontsource/comic-neue/files/comic-neue-latin-700-normal.woff2'),
    }
    if (!GlobalFonts.registerFromPath(paths.inter, 'Inter')) throw new Error('Could not register the Inter lettering font.')
    if (!GlobalFonts.registerFromPath(paths.comicNeue, 'Comic Neue')) throw new Error('Could not register the Comic Neue lettering font.')
  })
  return fontsReady
}
