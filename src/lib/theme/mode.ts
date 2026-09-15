/**
 * Light, dark, or whatever the OS is currently set to.
 *
 * This is the mode, not the palette: every theme in the picker carries both a
 * light and a dark set, and this decides which of the two is showing. The
 * class is applied to <html> by an inline script in index.html before the
 * first paint, so the value read here is only ever confirming what is already
 * on screen. Keep the storage key and the resolution rule in step with it.
 */

import { useCallback, useEffect, useState } from 'react'

import { applyThemeColor } from '@/lib/theme/apply'

export type Theme = 'light' | 'dark' | 'system'

export const THEMES: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
]

const DEFAULT_THEME: Theme = 'dark'
const STORAGE_KEY = 'kagi:theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system'
}

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return isTheme(stored) ? stored : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

function prefersDark(): boolean {
  return globalThis.matchMedia?.(DARK_QUERY).matches ?? false
}

export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme
  return prefersDark() ? 'dark' : 'light'
}

/** What is on screen right now, for callers that only need the answer. */
export function resolvedMode(): 'light' | 'dark' {
  return resolveTheme(readStoredTheme())
}

function applyTheme(theme: Theme): void {
  const resolved = resolveTheme(theme)
  document.documentElement.classList.toggle('dark', resolved === 'dark')
  applyThemeColor(resolved)
}

export function useTheme(): [Theme, (next: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(readStoredTheme)

  // The class is already correct on first render; this covers later changes,
  // and the OS flipping underneath a 'system' choice.
  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'system') return

    const query = globalThis.matchMedia?.(DARK_QUERY)
    if (!query) return

    const onChange = () => applyTheme('system')
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [theme])

  const update = useCallback((next: Theme) => {
    setTheme(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Private-mode storage refusal only costs the preference, not the theme.
    }
  }, [])

  return [theme, update]
}
