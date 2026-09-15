/**
 * Turning theme tokens into a stylesheet, and back again.
 *
 * The selectors are `html:root` and `html:root.dark` rather than the `:root`
 * and `.dark` used in index.css. That is not cosmetics: the injected sheet has
 * to win no matter where the bundler happens to put its own <style> tags, and
 * the extra type selector buys the specificity to make source order stop
 * mattering.
 */

import {
  hasAnyToken,
  sanitizeTokens,
  sanitizeVars,
  type ThemeTokens,
  type ThemeVars,
} from '@/lib/theme/tokens'

export const THEME_STYLE_ID = 'app-theme'

const LIGHT_SELECTOR = 'html:root'
const DARK_SELECTOR = 'html:root.dark'

function block(selector: string, vars: ThemeVars): string {
  const entries = Object.entries(vars)
  if (entries.length === 0) return ''
  const body = entries.map(([key, value]) => `  --${key}: ${value};`).join('\n')
  return `${selector} {\n${body}\n}\n`
}

/**
 * The whole theme as one stylesheet.
 *
 * Mode-independent tokens ride along in the light block; `.dark` only ever
 * needs to restate what actually differs, which is how tweakcn ships them.
 */
export function tokensToCss(tokens: ThemeTokens): string {
  const light = { ...(tokens.theme ?? {}), ...tokens.light }
  return `${block(LIGHT_SELECTOR, light)}${block(DARK_SELECTOR, tokens.dark)}`
}

const SWATCH_TOKENS = ['background', 'primary', 'secondary', 'accent', 'destructive'] as const

/**
 * The five colours a preview card shows.
 *
 * Falls back to the other mode per token rather than wholesale: a theme that
 * only restates what changes in `.dark` still previews correctly, because the
 * tokens it left out really are the light ones.
 */
export function swatchColors(tokens: ThemeTokens, mode: 'light' | 'dark'): string[] {
  const primary = mode === 'dark' ? tokens.dark : tokens.light
  const fallback = mode === 'dark' ? tokens.light : tokens.dark
  return SWATCH_TOKENS.map((token) => primary[token] ?? fallback[token] ?? 'transparent')
}

/** The background a mode resolves to, for the address-bar colour. */
export function themeColors(tokens: ThemeTokens): { light: string; dark: string } {
  const light = tokens.light.background ?? 'oklch(1 0 0)'
  return { light, dark: tokens.dark.background ?? light }
}

/**
 * Reads the CSS tweakcn's "copy code" button produces.
 *
 * Only `:root` / `.dark` custom-property declarations are looked at; `@theme`
 * blocks, `@layer` rules and anything else in the paste are skipped, and every
 * name and value still has to clear the allowlist afterwards.
 */
export function parseThemeCss(text: string): ThemeTokens {
  const light: Record<string, string> = {}
  const dark: Record<string, string> = {}

  const blockPattern = /([^{}]+)\{([^{}]*)\}/g
  for (const [, rawSelector, body] of text.matchAll(blockPattern)) {
    const selector = rawSelector.trim().toLowerCase()
    const isDark = selector.includes('.dark')
    const isLight = selector.includes(':root') || selector.includes('html')
    if (!isDark && !isLight) continue

    const target = isDark ? dark : light
    for (const [, key, value] of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);?/g)) {
      target[key] = value.trim()
    }
  }

  return sanitizeTokens({ light, dark })
}

/** Reads a shadcn registry item, which is what tweakcn's registry serves. */
export function parseRegistryItem(json: unknown): ThemeTokens {
  const item = json as { cssVars?: unknown; light?: unknown; dark?: unknown }
  const cssVars = (item?.cssVars ?? item) as Record<string, unknown>
  return sanitizeTokens({
    theme: cssVars?.theme,
    light: cssVars?.light,
    dark: cssVars?.dark,
  })
}

/**
 * Accepts whichever of the two formats was pasted.
 *
 * tweakcn hands out both a registry item and a block of CSS for the same
 * theme, and expecting someone to know which one they copied is a needless
 * way to fail an import.
 */
export function parseTheme(text: string): ThemeTokens | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const tokens = parseRegistryItem(JSON.parse(trimmed))
      return hasAnyToken(tokens) ? tokens : null
    } catch {
      return null
    }
  }

  const tokens = parseThemeCss(trimmed)
  return hasAnyToken(tokens) ? tokens : null
}

/** The reverse trip, for copying a saved theme back out. */
export function tokensToRegistryItem(
  name: string,
  tokens: ThemeTokens,
): Record<string, unknown> {
  return {
    $schema: 'https://ui.shadcn.com/schema/registry-item.json',
    name,
    type: 'registry:style',
    cssVars: {
      theme: sanitizeVars(tokens.theme),
      light: tokens.light,
      dark: tokens.dark,
    },
  }
}
