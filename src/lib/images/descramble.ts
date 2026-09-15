import type { Page } from '../sources/types'

export type DescrambleSpec = NonNullable<Page['descramble']>

/**
 * Raised when a browser can *display* an image but scripts may not *read* its
 * pixels — the signature of a CDN that serves images without CORS headers.
 *
 * This is not a bug we can work around. Reading pixels requires a CORS-approved
 * fetch; without one the canvas is tainted and every read throws SecurityError.
 */
export class ImageReadBlockedError extends Error {
  readonly host: string

  constructor(host: string, cause?: unknown) {
    super(
      `${host} does not permit reading image data, so scrambled pages cannot ` +
        `be unscrambled. The image can be displayed, but its pixels are ` +
        `unreadable to scripts, so the correct page cannot be reconstructed.`,
    )
    this.name = 'ImageReadBlockedError'
    this.host = host
    this.cause = cause
  }
}

/**
 * Reassemble a scrambled tile grid.
 *
 * The tile at read-order index `i` belongs at destination position `tiles[i]`.
 * Positions run left-to-right, top-to-bottom across a `cols` x `rows` grid.
 *
 * Throws `ImageReadBlockedError` when the source CDN withholds CORS headers.
 * Callers must surface that rather than falling back to the scrambled image,
 * which would present wrong pixels as if they were right.
 */
export async function descramblePage(
  imageUrl: string,
  spec: DescrambleSpec,
): Promise<Blob> {
  const { cols, rows, tiles } = spec

  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
    throw new Error(`Invalid tile grid: ${cols} x ${rows}.`)
  }
  if (tiles.length !== cols * rows) {
    throw new Error(
      `Tile map has ${tiles.length} entries but a ${cols} x ${rows} grid ` +
        `needs ${cols * rows}.`,
    )
  }

  const image = await loadReadableImage(imageUrl)

  // Uniform integer tiles. A permutation is only coherent if every tile is the
  // same size, so any remainder (< cols px right / < rows px bottom) is dropped.
  const tileWidth = Math.floor(image.naturalWidth / cols)
  const tileHeight = Math.floor(image.naturalHeight / rows)
  if (tileWidth < 1 || tileHeight < 1) {
    throw new Error(
      `Image is ${image.naturalWidth} x ${image.naturalHeight}, too small for ` +
        `a ${cols} x ${rows} tile grid.`,
    )
  }

  const surface = createSurface(tileWidth * cols, tileHeight * rows)

  for (let source = 0; source < tiles.length; source++) {
    const destination = tiles[source]
    if (
      !Number.isInteger(destination) ||
      destination < 0 ||
      destination >= tiles.length
    ) {
      throw new Error(
        `Tile map entry ${source} points at position ${destination}, which is ` +
          `outside the ${cols} x ${rows} grid.`,
      )
    }

    surface.context.drawImage(
      image,
      (source % cols) * tileWidth,
      Math.floor(source / cols) * tileHeight,
      tileWidth,
      tileHeight,
      (destination % cols) * tileWidth,
      Math.floor(destination / cols) * tileHeight,
      tileWidth,
      tileHeight,
    )
  }

  try {
    return await surface.toBlob()
  } catch (error) {
    if (isSecurityError(error)) {
      throw new ImageReadBlockedError(hostOf(imageUrl), error)
    }
    throw error
  }
}

// ----------------------------------------------------------------- loading --

/**
 * Load an image whose pixels are readable. `crossOrigin` is mandatory here and
 * deliberately not used for display, where it would break rendering outright on
 * a CDN that sends no CORS headers.
 */
async function loadReadableImage(url: string): Promise<HTMLImageElement> {
  try {
    return await loadImage(url, true)
  } catch (corsError) {
    // Tell "the image is missing" apart from "the image exists but refuses
    // CORS": if a plain load succeeds, only the readability requirement failed.
    const displayable = await loadImage(url, false).then(
      () => true,
      () => false,
    )
    if (displayable) throw new ImageReadBlockedError(hostOf(url), corsError)
    throw new Error(`Could not load the page image from ${hostOf(url)}.`)
  }
}

function loadImage(
  url: string,
  requireReadablePixels: boolean,
): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    if (requireReadablePixels) image.crossOrigin = 'anonymous'
    image.referrerPolicy = 'no-referrer'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Image load failed: ${url}`))
    image.src = url
  })
}

// ---------------------------------------------------------------- surfaces --

interface Surface {
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  toBlob(): Promise<Blob>
}

function createSurface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not acquire a 2D canvas context.')
    return {
      context,
      toBlob: () => canvas.convertToBlob({ type: 'image/png' }),
    }
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not acquire a 2D canvas context.')

  return {
    context,
    toBlob: () =>
      // A tainted canvas makes toBlob throw synchronously, which the executor
      // turns into a rejection.
      new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob)
          else reject(new Error('The canvas produced no image data.'))
        }, 'image/png')
      }),
  }
}

function isSecurityError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'SecurityError'
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'the image host'
  }
}
