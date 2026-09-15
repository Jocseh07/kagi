/**
 * The picker's state: which themes exist, which one is on, and the four things
 * you can do to the list.
 *
 * Selecting is deliberately not asynchronous. The preset is already in memory
 * by the time a card can be clicked, so applying it is a synchronous style
 * write and the colours change on the same frame as the click.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { applyThemePreset } from '@/lib/theme/apply'
import { loadPresets, refreshPresets } from '@/lib/theme/catalog'
import { DEFAULT_PRESET, DEFAULT_PRESET_ID } from '@/lib/theme/default-preset'
import { resolvedMode } from '@/lib/theme/mode'
import {
  readActiveThemeId,
  readCustomThemes,
  writeCustomThemes,
} from '@/lib/theme/store'
import { slugify, type ThemePreset, type ThemeTokens } from '@/lib/theme/tokens'

export type ThemePresetsState = {
  builtIn: ThemePreset[]
  custom: ThemePreset[]
  activeId: string
  loading: boolean
  refreshing: boolean
  refreshError: string | null
  select: (preset: ThemePreset) => void
  saveCustom: (title: string, tokens: ThemeTokens) => ThemePreset
  renameCustom: (id: string, title: string) => void
  deleteCustom: (id: string) => void
  refresh: () => Promise<void>
}

export function useThemePresets(): ThemePresetsState {
  const [builtIn, setBuiltIn] = useState<ThemePreset[]>([DEFAULT_PRESET])
  const [custom, setCustom] = useState<ThemePreset[]>(readCustomThemes)
  const [activeId, setActiveId] = useState<string>(readActiveThemeId)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    loadPresets()
      .then((presets) => {
        if (live) setBuiltIn(presets)
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [])

  const select = useCallback((preset: ThemePreset) => {
    applyThemePreset(preset, resolvedMode())
    setActiveId(preset.id)
  }, [])

  const persist = useCallback((next: ThemePreset[]) => {
    setCustom(next)
    writeCustomThemes(next)
  }, [])

  // Prefixed, so a saved theme can never take the id of a tweakcn one that has
  // not finished loading yet and quietly shadow it in the grid.
  const takenIds = useMemo(() => new Set(custom.map((p) => p.id)), [custom])

  const saveCustom = useCallback(
    (title: string, tokens: ThemeTokens) => {
      const preset: ThemePreset = {
        id: slugify(`custom-${title}`, takenIds),
        title: title.trim() || 'Untitled theme',
        source: 'custom',
        tokens,
      }
      persist([...custom, preset])
      return preset
    },
    [custom, persist, takenIds],
  )

  const renameCustom = useCallback(
    (id: string, title: string) => {
      persist(custom.map((p) => (p.id === id ? { ...p, title: title.trim() || p.title } : p)))
    },
    [custom, persist],
  )

  const deleteCustom = useCallback(
    (id: string) => {
      persist(custom.filter((p) => p.id !== id))
      // Deleting what you are looking at would otherwise leave the app wearing
      // a theme that no longer exists anywhere.
      if (id === activeId) {
        applyThemePreset(DEFAULT_PRESET, resolvedMode())
        setActiveId(DEFAULT_PRESET_ID)
      }
    },
    [activeId, custom, persist],
  )

  const refresh = useCallback(async () => {
    setRefreshing(true)
    setRefreshError(null)
    try {
      setBuiltIn(await refreshPresets())
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : 'Could not reach tweakcn')
    } finally {
      setRefreshing(false)
    }
  }, [])

  return {
    builtIn,
    custom,
    activeId,
    loading,
    refreshing,
    refreshError,
    select,
    saveCustom,
    renameCustom,
    deleteCustom,
    refresh,
  }
}
