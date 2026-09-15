/**
 * The list of themes to choose from.
 *
 * The tweakcn catalog is a quarter of a megabyte of JSON that nothing needs
 * until someone opens the picker, so it is behind a dynamic import and never
 * reaches the initial bundle. The active theme does not go through here at
 * all — it is already a stylesheet in localStorage by the time this loads.
 */

import { DEFAULT_PRESET } from '@/lib/theme/default-preset'
import { sanitizeTokens, type ThemePreset } from '@/lib/theme/tokens'

export const TWEAKCN_REGISTRY_URL = 'https://tweakcn.com/r/themes/registry.json'
export const THEME_CATALOG_KEY = 'kagi:theme-catalog'

let cached: ThemePreset[] | null = null

function normalize(entries: unknown, source: 'tweakcn'): ThemePreset[] {
  if (!Array.isArray(entries)) return []

  return entries.flatMap((entry: unknown) => {
    const item = entry as Partial<ThemePreset>
    if (typeof item?.id !== 'string' || item.id.length === 0) return []
    return [
      {
        id: item.id,
        title: typeof item.title === 'string' ? item.title : item.id,
        description: typeof item.description === 'string' ? item.description : undefined,
        source,
        tokens: sanitizeTokens(item.tokens),
      },
    ]
  })
}

function readRefreshed(): ThemePreset[] | null {
  try {
    const raw = globalThis.localStorage?.getItem(THEME_CATALOG_KEY)
    if (!raw) return null
    const presets = normalize(JSON.parse(raw), 'tweakcn')
    return presets.length > 0 ? presets : null
  } catch {
    return null
  }
}

/** Default first, then every tweakcn theme. */
export async function loadPresets(): Promise<ThemePreset[]> {
  if (cached) return cached

  const refreshed = readRefreshed()
  if (refreshed) {
    cached = [DEFAULT_PRESET, ...refreshed]
    return cached
  }

  const bundled = await import('@/lib/theme/presets.json')
  cached = [DEFAULT_PRESET, ...normalize(bundled.default, 'tweakcn')]
  return cached
}

/**
 * Pulls the current registry from tweakcn and keeps it for next time.
 *
 * Offline or a bad response leaves the bundled list exactly as it was; there
 * is no half-applied state to unwind.
 */
export async function refreshPresets(): Promise<ThemePreset[]> {
  const response = await fetch(TWEAKCN_REGISTRY_URL, { cache: 'no-store' })
  if (!response.ok) throw new Error(`tweakcn responded ${response.status}`)

  const registry = (await response.json()) as { items?: unknown[] }
  const items = registry.items ?? []

  const presets = items.flatMap((entry: unknown) => {
    const item = entry as { name?: string; title?: string; description?: string; cssVars?: unknown }
    if (typeof item?.name !== 'string' || item.name.length === 0) return []
    return [
      {
        id: item.name,
        title: item.title ?? item.name,
        description: item.description,
        source: 'tweakcn' as const,
        tokens: sanitizeTokens(item.cssVars),
      },
    ]
  })

  if (presets.length === 0) throw new Error('tweakcn returned no themes')

  try {
    globalThis.localStorage?.setItem(THEME_CATALOG_KEY, JSON.stringify(presets))
  } catch {
    // Over quota or blocked: this run still gets the fresh list.
  }

  cached = [DEFAULT_PRESET, ...presets]
  return cached
}
