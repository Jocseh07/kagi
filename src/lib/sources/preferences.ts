/**
 * Bridges persisted `source_prefs` rows to the in-memory preference record a
 * source expects. Values are stored as text; switches round-trip as 'true'/'false'.
 */

import { getSourcePrefs } from '@/lib/db/repositories'
import { listSources } from './registry'
import { isConfigurable } from './types'
import type { ConfigurableSource, Source, SourcePreference } from './types'

export type PrefValue = string | boolean

export type ConfigurableSourceEntry = Source & ConfigurableSource

export function encodePref(value: PrefValue): string {
  return typeof value === 'boolean' ? String(value) : value
}

export function decodePref(
  preference: SourcePreference,
  raw: string | undefined,
): PrefValue {
  if (raw === undefined) return preference.default
  return preference.type === 'switch' ? raw === 'true' : raw
}

/** Declared preferences filled in from `stored`, falling back to defaults. */
export function resolvePrefs(
  source: ConfigurableSource,
  stored: Record<string, string>,
): Record<string, PrefValue> {
  const values: Record<string, PrefValue> = {}
  for (const preference of source.getPreferences()) {
    values[preference.key] = decodePref(preference, stored[preference.key])
  }
  return values
}

export async function loadSourcePrefs(
  source: ConfigurableSourceEntry,
): Promise<Record<string, PrefValue>> {
  const values = resolvePrefs(source, await getSourcePrefs(source.id))
  source.setPreferences(values)
  return values
}

export function configurableSources(): ConfigurableSourceEntry[] {
  return listSources().filter(isConfigurable)
}

/** Applied once at startup so persisted settings affect the first fetch. */
export async function applyStoredPreferences(): Promise<void> {
  for (const source of configurableSources()) {
    try {
      await loadSourcePrefs(source)
    } catch {
      // Unreadable prefs must not block boot; the source keeps its defaults.
    }
  }
}
