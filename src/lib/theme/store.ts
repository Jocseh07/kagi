/**
 * Where a chosen theme lives between visits.
 *
 * The active theme is stored as the finished stylesheet rather than as tokens,
 * because the only thing that reads it first is the blocking script in
 * index.html, and that script should not have to know how a theme is built.
 * Custom themes are stored as tokens, because those do get edited.
 */

import { DEFAULT_PRESET_ID } from '@/lib/theme/default-preset'
import { themeColors, tokensToCss } from '@/lib/theme/css'
import { sanitizeTokens, type ThemePreset } from '@/lib/theme/tokens'

export const ACTIVE_THEME_KEY = 'kagi:theme-active'
export const CUSTOM_THEMES_KEY = 'kagi:custom-themes'

export type ActiveTheme = {
  id: string
  css: string
  color: { light: string; dark: string }
}

function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    // Private-mode storage refusal; treat as nothing stored.
    return null
  }
}

function write(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // The theme is already on screen; only its persistence is lost.
  }
}

function remove(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key)
  } catch {
    // As above.
  }
}

export function toActiveTheme(preset: ThemePreset): ActiveTheme {
  return {
    id: preset.id,
    css: tokensToCss(preset.tokens),
    color: themeColors(preset.tokens),
  }
}

export function readActiveTheme(): ActiveTheme | null {
  const raw = read(ACTIVE_THEME_KEY)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Partial<ActiveTheme>
    if (typeof parsed?.id !== 'string' || typeof parsed?.css !== 'string') return null
    return {
      id: parsed.id,
      css: parsed.css,
      color: {
        light: parsed.color?.light ?? 'oklch(1 0 0)',
        dark: parsed.color?.dark ?? 'oklch(0.145 0 0)',
      },
    }
  } catch {
    return null
  }
}

/** The id the app is on, with the built-in default standing in for nothing. */
export function readActiveThemeId(): string {
  return readActiveTheme()?.id ?? DEFAULT_PRESET_ID
}

export function writeActiveTheme(preset: ThemePreset): void {
  // The default is what index.css already paints, so storing a copy of it
  // would only be a second thing to keep in step.
  if (preset.id === DEFAULT_PRESET_ID) {
    remove(ACTIVE_THEME_KEY)
    return
  }
  write(ACTIVE_THEME_KEY, JSON.stringify(toActiveTheme(preset)))
}

export function readCustomThemes(): ThemePreset[] {
  const raw = read(CUSTOM_THEMES_KEY)
  if (!raw) return []

  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    return parsed.flatMap((entry: unknown) => {
      const item = entry as Partial<ThemePreset>
      if (typeof item?.id !== 'string' || typeof item?.title !== 'string') return []
      return [
        {
          id: item.id,
          title: item.title,
          description: typeof item.description === 'string' ? item.description : undefined,
          source: 'custom' as const,
          tokens: sanitizeTokens(item.tokens),
        },
      ]
    })
  } catch {
    return []
  }
}

export function writeCustomThemes(themes: ThemePreset[]): void {
  write(CUSTOM_THEMES_KEY, JSON.stringify(themes))
}
