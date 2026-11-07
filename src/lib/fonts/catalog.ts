import { GOOGLE_FONT_PREFIX, googleFont, normalizeFontName, readCustomFonts } from '@/lib/fonts/custom'
import { FONTS } from './model'
import type { FontOption } from './model'

export function findFont(id: string | null): FontOption | null {
  if (!id) return null
  const builtIn = FONTS.find((font) => font.id === id)
  if (builtIn) return builtIn
  if (!id.startsWith(GOOGLE_FONT_PREFIX)) return null
  // A synced reader setting can name a font this device never added.
  const name = normalizeFontName(id.slice(GOOGLE_FONT_PREFIX.length))
  if (!name) return null
  return readCustomFonts().find((font) => font.id === id) ?? googleFont(name)
}
