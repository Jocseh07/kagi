/**
 * How big the app is, and where that lives.
 *
 * Tailwind sizes text, padding, gaps and radius in `rem`, so the honest lever
 * for "make the app bigger" is the root font size: everything scales together
 * and no box has to be re-tested at a size its padding never anticipated.
 * Scaling text alone would just push it against borders it no longer fits in.
 *
 * The mechanics are the font picker's, deliberately: a rule doubled to
 * `html:root:root` so it outranks a theme regardless of which <style> lands in
 * head first, the id stored as the record of what was picked, and the finished
 * rule stored beside it so the pre-paint script in lib/theme/boot-script can
 * replay it without carrying a copy of this table.
 *
 * This is the interface. A novel's prose has its own size in the reader's
 * settings and is not touched by this.
 */

export type TextSizeId = 'small' | 'default' | 'large' | 'larger' | 'largest'

export const DEFAULT_TEXT_SIZE_ID: TextSizeId = 'default'

/**
 * Five steps rather than a slider: there is no shared slider primitive, and a
 * free range invites sizes nobody has ever looked at. `default` is 16px, the
 * browser's own, which is what the app rendered at before this existed.
 */
export const TEXT_SIZE_OPTIONS = [
  { id: 'small', label: 'Small', px: 15 },
  { id: 'default', label: 'Default', px: 16 },
  { id: 'large', label: 'Large', px: 17.5 },
  { id: 'larger', label: 'Larger', px: 19 },
  { id: 'largest', label: 'Largest', px: 21 },
] as const satisfies ReadonlyArray<{ id: TextSizeId; label: string; px: number }>

export const ACTIVE_TEXT_SIZE_KEY = 'kagi:text-size'
export const ACTIVE_TEXT_SIZE_CSS_KEY = 'kagi:text-size-css'
export const TEXT_SIZE_STYLE_ID = 'app-text-size'

export function findTextSize(id: string | null | undefined) {
  return TEXT_SIZE_OPTIONS.find((option) => option.id === id) ?? null
}

/** The one rule a chosen size amounts to. Keep in step with the boot script. */
export function textSizeCss(px: number): string {
  return `html:root:root { font-size: ${px}px; }`
}

export function readActiveTextSizeId(): TextSizeId {
  try {
    const stored = globalThis.localStorage?.getItem(ACTIVE_TEXT_SIZE_KEY) ?? null
    return findTextSize(stored)?.id ?? DEFAULT_TEXT_SIZE_ID
  } catch {
    // Private-mode storage refusal; treat as nothing stored.
    return DEFAULT_TEXT_SIZE_ID
  }
}

function persist(id: TextSizeId, css: string): void {
  try {
    if (id === DEFAULT_TEXT_SIZE_ID) {
      globalThis.localStorage?.removeItem(ACTIVE_TEXT_SIZE_KEY)
      globalThis.localStorage?.removeItem(ACTIVE_TEXT_SIZE_CSS_KEY)
      return
    }
    globalThis.localStorage?.setItem(ACTIVE_TEXT_SIZE_KEY, id)
    globalThis.localStorage?.setItem(ACTIVE_TEXT_SIZE_CSS_KEY, css)
  } catch {
    // The size is already on screen; only its persistence is lost.
  }
}

function styleElement(): HTMLStyleElement | null {
  if (typeof document === 'undefined') return null

  const existing = document.getElementById(TEXT_SIZE_STYLE_ID)
  if (existing instanceof HTMLStyleElement) return existing

  const created = document.createElement('style')
  created.id = TEXT_SIZE_STYLE_ID
  document.head.append(created)
  return created
}

/**
 * Resizes the app and remembers it.
 *
 * The default empties the sheet rather than writing 16px into it, so the app
 * goes back to inheriting the browser's own size — which is the setting of
 * anyone who has already turned their whole browser up.
 */
export function applyTextSize(id: TextSizeId): void {
  const option = findTextSize(id) ?? findTextSize(DEFAULT_TEXT_SIZE_ID)!
  const css = option.id === DEFAULT_TEXT_SIZE_ID ? '' : textSizeCss(option.px)
  const element = styleElement()
  if (element) element.textContent = css
  persist(option.id, css)
}
