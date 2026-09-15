/**
 * Putting a theme on screen.
 *
 * One <style> element, rewritten in place. Swapping its text is a single style
 * recalculation and every shadcn token is already a var(), so the whole app
 * recolours without a component re-rendering.
 */

import { DEFAULT_PRESET_ID } from '@/lib/theme/default-preset'
import { THEME_STYLE_ID } from '@/lib/theme/css'
import { readActiveTheme, toActiveTheme, writeActiveTheme } from '@/lib/theme/store'
import type { ThemePreset } from '@/lib/theme/tokens'

function styleElement(): HTMLStyleElement | null {
  if (typeof document === 'undefined') return null

  const existing = document.getElementById(THEME_STYLE_ID)
  if (existing instanceof HTMLStyleElement) return existing

  const created = document.createElement('style')
  created.id = THEME_STYLE_ID
  document.head.append(created)
  return created
}

/**
 * The default theme's backgrounds as sRGB.
 *
 * `theme-color` is read by the browser chrome rather than by the page, and not
 * every one of them parses oklch, so the one colour the app ships with is
 * given in a form all of them understand. A theme's own value is passed
 * through as authored; the worst case there is a browser ignoring it.
 */
const DEFAULT_THEME_COLOR = { light: '#ffffff', dark: '#0a0a0a' } as const

/** Address-bar colour, following whichever mode is actually showing. */
export function applyThemeColor(resolved: 'light' | 'dark'): void {
  if (typeof document === 'undefined') return

  const active = readActiveTheme()
  const color = active?.color ?? DEFAULT_THEME_COLOR
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', color[resolved])
}

/** Paints the browser chrome a fixed colour, ignoring the active theme. */
export function overrideThemeColor(color: string): void {
  if (typeof document === 'undefined') return

  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', color)
}

/**
 * Applies a preset and remembers it.
 *
 * The default clears the sheet rather than filling it, which hands the app
 * back to the identical values in index.css.
 */
export function applyThemePreset(preset: ThemePreset, resolved: 'light' | 'dark'): void {
  const element = styleElement()
  if (element) {
    element.textContent = preset.id === DEFAULT_PRESET_ID ? '' : toActiveTheme(preset).css
  }
  writeActiveTheme(preset)
  applyThemeColor(resolved)
}
