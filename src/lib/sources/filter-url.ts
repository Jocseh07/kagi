/**
 * Compact URL encoding for a source's `FilterList`.
 *
 * A filter list is source-defined, nested and often long, so the URL carries
 * only the leaves the user moved off their default, keyed by index path
 * ("3.2" = child 2 of filter 3). Applying a diff walks a fresh copy of the
 * defaults, which means an unknown or mistyped entry is simply ignored rather
 * than corrupting the list a hand-edited URL is applied to.
 */

import type { Filter, FilterList } from '@/lib/sources/types'

export type FilterDiffValue =
  | string
  | number
  | boolean
  | { index: number; ascending: boolean }

export type FilterDiff = Record<string, FilterDiffValue>

/** Only the states that differ from `defaults`, or `undefined` when none do. */
export function encodeFilterDiff(
  filters: FilterList,
  defaults: FilterList,
): FilterDiff | undefined {
  const diff: FilterDiff = {}
  collect(filters, defaults, '', diff)
  return Object.keys(diff).length > 0 ? diff : undefined
}

function collect(
  filters: FilterList,
  defaults: FilterList,
  prefix: string,
  out: FilterDiff,
): void {
  filters.forEach((filter, index) => {
    const fallback = defaults[index]
    // A list shaped differently from the defaults cannot be diffed against
    // them position by position; skipping keeps the rest of the walk honest.
    if (!fallback || fallback.type !== filter.type) return

    const path = prefix ? `${prefix}.${index}` : String(index)

    if (filter.type === 'group' && fallback.type === 'group') {
      collect(filter.state, fallback.state, path, out)
      return
    }

    if (filter.type === 'sort' && fallback.type === 'sort') {
      if (
        filter.state.index !== fallback.state.index ||
        filter.state.ascending !== fallback.state.ascending
      ) {
        out[path] = { ...filter.state }
      }
      return
    }

    if (
      (filter.type === 'text' ||
        filter.type === 'select' ||
        filter.type === 'checkbox' ||
        filter.type === 'tristate') &&
      filter.state !== (fallback as typeof filter).state
    ) {
      out[path] = filter.state
    }
  })
}

/** A copy of `defaults` with every valid entry of `diff` written back into it. */
export function applyFilterDiff(
  defaults: FilterList,
  diff: FilterDiff,
): FilterList {
  const filters = structuredClone(defaults)
  write(filters, '', diff)
  return filters
}

function write(filters: FilterList, prefix: string, diff: FilterDiff): void {
  filters.forEach((filter, index) => {
    const path = prefix ? `${prefix}.${index}` : String(index)

    if (filter.type === 'group') {
      write(filter.state, path, diff)
      return
    }

    if (!(path in diff)) return
    const value = diff[path]!
    const next = stateOf(filter, value)
    if (next !== undefined) {
      Object.assign(filter, { state: next })
    }
  })
}

/** The value coerced to what this filter's `state` accepts, or `undefined`. */
function stateOf(
  filter: Filter,
  value: FilterDiffValue,
): FilterDiffValue | undefined {
  switch (filter.type) {
    case 'text':
      return typeof value === 'string' ? value : undefined
    case 'select':
      return typeof value === 'number' && Number.isInteger(value) &&
        value >= 0 &&
        value < filter.values.length
        ? value
        : undefined
    case 'checkbox':
      return typeof value === 'boolean' ? value : undefined
    case 'tristate':
      return value === 0 || value === 1 || value === 2 ? value : undefined
    case 'sort':
      return isSortState(value) && value.index < filter.values.length
        ? { index: value.index, ascending: value.ascending }
        : undefined
    case 'header':
    case 'separator':
    case 'group':
      return undefined
  }
}

function isSortState(
  value: FilterDiffValue,
): value is { index: number; ascending: boolean } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.index === 'number' &&
    Number.isInteger(value.index) &&
    value.index >= 0 &&
    typeof value.ascending === 'boolean'
  )
}

/**
 * The index path of the toggle standing for `genre`, if the source has one.
 *
 * Matched on the label a source shows, case-insensitively, because that is the
 * only thing a series' tag and a source's filter list have in common. Groups
 * are walked into, so it makes no difference whether a source files its genres
 * under a "Genres" heading or lists them flat.
 */
export function findGenreFilterPath(
  filters: FilterList,
  genre: string,
): { path: string; value: FilterDiffValue } | undefined {
  const wanted = genre.trim().toLowerCase()
  if (!wanted) return undefined

  const search = (
    list: FilterList,
    prefix: string,
  ): { path: string; value: FilterDiffValue } | undefined => {
    for (const [index, filter] of list.entries()) {
      const path = prefix ? `${prefix}.${index}` : String(index)

      if (filter.type === 'group') {
        const found = search(filter.state, path)
        if (found) return found
        continue
      }

      if (filter.type !== 'checkbox' && filter.type !== 'tristate') continue
      if (filter.name.trim().toLowerCase() !== wanted) continue

      // A tristate's "include" is 1, where a checkbox's is simply on.
      return { path, value: filter.type === 'checkbox' ? true : 1 }
    }
    return undefined
  }

  return search(filters, '')
}

/** Validates a raw search param into a diff, dropping anything unusable. */
export function parseFilterDiff(value: unknown): FilterDiff | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }

  const diff: FilterDiff = {}
  for (const [path, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d+(\.\d+)*$/.test(path)) continue
    if (
      typeof entry === 'string' ||
      typeof entry === 'number' ||
      typeof entry === 'boolean'
    ) {
      diff[path] = entry
    } else if (isSortState(entry as FilterDiffValue)) {
      diff[path] = entry as { index: number; ascending: boolean }
    }
  }

  return Object.keys(diff).length > 0 ? diff : undefined
}
