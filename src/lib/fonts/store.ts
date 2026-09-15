/**
 * Where the chosen font lives, and how it beats the theme.
 *
 * A theme carries its own `--font-sans`, injected as `html:root` rules into
 * <style id="app-theme"> (see lib/theme/css). A font picked here has to outrank
 * that, and cannot rely on coming later in the document: applying a theme
 * creates the theme element on demand, so it may well be appended *after* this
 * one. Doubling the pseudo-class — `html:root:root` — settles it on
 * specificity instead, which no ordering can undo.
 *
 * The id is the record of what was picked; the rule built from it is stored
 * alongside, because the first thing to read it is the blocking script in
 * index.html and that script should no more carry a copy of the catalog than
 * it carries a copy of the theme builder. The id is what is re-read on the way
 * back, so fixing a family's fallbacks still reaches everyone who picked it.
 */

import { findFont } from '@/lib/fonts/catalog'

export const ACTIVE_FONT_KEY = 'kagi:font'
export const ACTIVE_FONT_CSS_KEY = 'kagi:font-css'
export const FONT_STYLE_ID = 'app-font'

/** The one rule a chosen font amounts to. Keep in step with index.html. */
export function fontCss(stack: string): string {
  return `html:root:root { --font-sans: ${stack}; }`
}

export function readActiveFontId(): string | null {
  try {
    const stored = globalThis.localStorage?.getItem(ACTIVE_FONT_KEY) ?? null
    return findFont(stored) ? stored : null
  } catch {
    // Private-mode storage refusal; treat as nothing stored.
    return null
  }
}

function persist(id: string | null, css: string): void {
  try {
    if (id === null) {
      globalThis.localStorage?.removeItem(ACTIVE_FONT_KEY)
      globalThis.localStorage?.removeItem(ACTIVE_FONT_CSS_KEY)
      return
    }
    globalThis.localStorage?.setItem(ACTIVE_FONT_KEY, id)
    globalThis.localStorage?.setItem(ACTIVE_FONT_CSS_KEY, css)
  } catch {
    // The font is already on screen; only its persistence is lost.
  }
}

function styleElement(): HTMLStyleElement | null {
  if (typeof document === 'undefined') return null

  const existing = document.getElementById(FONT_STYLE_ID)
  if (existing instanceof HTMLStyleElement) return existing

  const created = document.createElement('style')
  created.id = FONT_STYLE_ID
  document.head.append(created)
  return created
}

/** Puts a font on screen and remembers it; null hands the app back to the theme. */
export function applyFont(id: string | null): void {
  const font = findFont(id)
  const css = font ? fontCss(font.stack) : ''
  const element = styleElement()
  if (element) element.textContent = css
  persist(font ? font.id : null, css)
}
