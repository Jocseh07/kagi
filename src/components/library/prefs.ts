/**
 * Filter, sort and last-category choices, kept in the `settings` table so they
 * survive a reload. A write that fails is swallowed: a preference that will not
 * persist is not a reason to break the page.
 */

import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import {
  DEFAULT_LIBRARY_FILTERS,
  DEFAULT_LIBRARY_SORT,
} from '@/lib/db/library'
import type {
  LibraryFilters,
  LibrarySort,
  LibrarySortKey,
  LibraryTriState,
} from '@/lib/db/library'
import { getSetting, setSetting } from '@/lib/db/repositories'

export interface LibraryPrefs {
  filters: LibraryFilters
  sort: LibrarySort
  /** `null` is the "All" tab. */
  categoryId: string | null
}

export const DEFAULT_LIBRARY_PREFS: LibraryPrefs = {
  filters: DEFAULT_LIBRARY_FILTERS,
  sort: DEFAULT_LIBRARY_SORT,
  categoryId: null,
}

const FILTERS_KEY = 'library.filters'
const SORT_KEY = 'library.sort'
const CATEGORY_KEY = 'library.category'

export const libraryPrefsQueryKey = ['db', 'settings', 'library'] as const

const SORT_KEYS: readonly LibrarySortKey[] = [
  'alphabetical',
  'lastRead',
  'lastChecked',
  'unreadCount',
  'totalChapters',
  'latestChapter',
  'dateAdded',
  'random',
]

export async function loadLibraryPrefs(): Promise<LibraryPrefs> {
  const [filters, sort, categoryId] = await Promise.all([
    getSetting(FILTERS_KEY),
    getSetting(SORT_KEY),
    getSetting(CATEGORY_KEY),
  ])

  return {
    filters: parseFilters(filters),
    sort: parseSort(sort),
    categoryId: categoryId || null,
  }
}

export function useLibraryPrefs(enabled: boolean): {
  prefs: LibraryPrefs
  loading: boolean
  setFilters(filters: LibraryFilters): void
  setSort(sort: LibrarySort): void
  setCategoryId(categoryId: string | null): void
} {
  const queryClient = useQueryClient()
  const stored = useQuery({
    queryKey: libraryPrefsQueryKey,
    queryFn: loadLibraryPrefs,
    enabled,
    staleTime: Infinity,
  })

  const prefs = stored.data ?? DEFAULT_LIBRARY_PREFS

  // Written straight into the query cache: the grid reacts immediately, and
  // the value survives leaving the page, since the query is never refetched.
  const patch = useCallback(
    (next: Partial<LibraryPrefs>) => {
      queryClient.setQueryData<LibraryPrefs>(libraryPrefsQueryKey, (current) => ({
        ...(current ?? DEFAULT_LIBRARY_PREFS),
        ...next,
      }))
    },
    [queryClient],
  )

  const setFilters = useCallback(
    (filters: LibraryFilters) => {
      patch({ filters })
      persist(FILTERS_KEY, JSON.stringify(filters))
    },
    [patch],
  )

  const setSort = useCallback(
    (sort: LibrarySort) => {
      patch({ sort })
      persist(SORT_KEY, JSON.stringify(sort))
    },
    [patch],
  )

  const setCategoryId = useCallback(
    (categoryId: string | null) => {
      patch({ categoryId })
      persist(CATEGORY_KEY, categoryId ?? '')
    },
    [patch],
  )

  return {
    prefs,
    loading: enabled && stored.isPending,
    setFilters,
    setSort,
    setCategoryId,
  }
}

function persist(key: string, value: string): void {
  void setSetting(key, value).catch(() => undefined)
}

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function triOf(value: unknown): LibraryTriState {
  return value === 1 || value === 2 ? value : 0
}

function parseFilters(raw: string | null): LibraryFilters {
  const parsed = parseJson(raw)
  if (!parsed) return DEFAULT_LIBRARY_FILTERS
  return {
    downloaded: triOf(parsed.downloaded),
    unread: triOf(parsed.unread),
    started: triOf(parsed.started),
    bookmarked: triOf(parsed.bookmarked),
    completed: triOf(parsed.completed),
  }
}

function parseSort(raw: string | null): LibrarySort {
  const parsed = parseJson(raw)
  if (!parsed) return DEFAULT_LIBRARY_SORT
  const key = SORT_KEYS.find((candidate) => candidate === parsed.key)
  return {
    key: key ?? DEFAULT_LIBRARY_SORT.key,
    ascending:
      typeof parsed.ascending === 'boolean'
        ? parsed.ascending
        : DEFAULT_LIBRARY_SORT.ascending,
  }
}
