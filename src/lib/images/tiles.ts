import type { Page } from '../sources/types'

export type DescrambleSpec = NonNullable<Page['descramble']>

export function validateTileGrid({ cols, rows, tiles }: DescrambleSpec): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
    throw new Error(`Invalid tile grid: ${cols} x ${rows}.`)
  }
  if (tiles.length !== cols * rows) {
    throw new Error(`Tile map has ${tiles.length} entries but a ${cols} x ${rows} grid needs ${cols * rows}.`)
  }
  for (const [source, destination] of tiles.entries()) {
    if (!Number.isInteger(destination) || destination < 0 || destination >= tiles.length) {
      throw new Error(`Tile map entry ${source} points at position ${destination}, which is outside the ${cols} x ${rows} grid.`)
    }
  }
}

export function tileLayout(width: number, height: number, spec: DescrambleSpec) {
  validateTileGrid(spec)
  const { cols, rows, tiles } = spec
  const tileWidth = Math.floor(width / cols)
  const tileHeight = Math.floor(height / rows)
  if (tileWidth < 1 || tileHeight < 1) {
    throw new Error(`Image is ${width} x ${height}, too small for a ${cols} x ${rows} tile grid.`)
  }
  return {
    width: tileWidth * cols,
    height: tileHeight * rows,
    tiles: tiles.map((destination, source) => ({
      sx: (source % cols) * tileWidth,
      sy: Math.floor(source / cols) * tileHeight,
      dx: (destination % cols) * tileWidth,
      dy: Math.floor(destination / cols) * tileHeight,
      width: tileWidth,
      height: tileHeight,
    })),
  }
}
