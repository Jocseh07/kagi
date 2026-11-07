export type CanvasContext = OffscreenCanvasRenderingContext2D
export interface CanvasImage {
  width: number
  height: number
  image: ImageBitmap | null
}

export function createCanvas(width: number, height: number): OffscreenCanvas {
  return new OffscreenCanvas(width, height)
}

export async function loadCanvasImage(blob: Blob): Promise<CanvasImage> {
  const image = await createImageBitmap(blob)
  return { width: image.width, height: image.height, image }
}

export function releaseCanvasImage(image: CanvasImage): void {
  image.image?.close()
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

export function loadCanvasFonts(): Promise<void> {
  fontsReady ??= (async () => {
    if (typeof document === 'undefined' || !document.fonts) return
    try {
      await Promise.all([
        document.fonts.load('400 28px Inter'),
        document.fonts.load('700 28px Inter'),
        document.fonts.load("700 28px 'Comic Neue'"),
      ])
    } catch {
      return
    }
  })()
  return fontsReady
}
