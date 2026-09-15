import { useCallback, useEffect, useState } from 'react'

import { findFont } from '@/lib/fonts/catalog'

export type ReaderMode = 'continuous' | 'paged-ltr' | 'paged-rtl'

export const READER_MODES: { value: ReaderMode; label: string }[] = [
  { value: 'continuous', label: 'Continuous' },
  { value: 'paged-ltr', label: 'Paged, left to right' },
  { value: 'paged-rtl', label: 'Paged, right to left' },
]

// Webtoons are the norm for the sources shipped here, so vertical wins.
const DEFAULT_MODE: ReaderMode = 'continuous'
const STORAGE_KEY = 'kagi:reader-mode'

function isReaderMode(value: unknown): value is ReaderMode {
  return (
    value === 'continuous' || value === 'paged-ltr' || value === 'paged-rtl'
  )
}

function readStoredMode(): ReaderMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return isReaderMode(stored) ? stored : DEFAULT_MODE
  } catch {
    return DEFAULT_MODE
  }
}

export function useReaderMode(): [ReaderMode, (next: ReaderMode) => void] {
  return useStoredPreference(STORAGE_KEY, readStoredMode)
}

// ------------------------------------------------------------ resume point --

export type ResumeBehavior = 'silent' | 'notify' | 'restart'

export const RESUME_BEHAVIORS: {
  value: ResumeBehavior
  label: string
  summary: string
}[] = [
  {
    value: 'silent',
    label: 'Continue where I left off',
    summary: 'The chapter opens at your position, with nothing to dismiss.',
  },
  {
    value: 'notify',
    label: 'Continue and tell me',
    summary: 'A bar offers to start over for a few seconds.',
  },
  {
    value: 'restart',
    label: 'Always start at the beginning',
    summary: 'Your position is still recorded, it just is not used to open.',
  },
]

// Resuming silently is what reopening a book does; being told is the exception.
const DEFAULT_RESUME: ResumeBehavior = 'silent'
const RESUME_STORAGE_KEY = 'kagi:reader-resume'

function isResumeBehavior(value: unknown): value is ResumeBehavior {
  return value === 'silent' || value === 'notify' || value === 'restart'
}

function readStoredResume(): ResumeBehavior {
  try {
    const stored = localStorage.getItem(RESUME_STORAGE_KEY)
    return isResumeBehavior(stored) ? stored : DEFAULT_RESUME
  } catch {
    return DEFAULT_RESUME
  }
}

export function useResumeBehavior(): [
  ResumeBehavior,
  (next: ResumeBehavior) => void,
] {
  return useStoredPreference(RESUME_STORAGE_KEY, readStoredResume)
}

// -------------------------------------------------------------- fullscreen --

const FULLSCREEN_STORAGE_KEY = 'kagi:reader-fullscreen'

/** Idle time before the fullscreen reader fades down and lets the screen lock. */
export const DIM_AFTER_MS = 20_000

function readStoredFullscreen(): 'on' | 'off' {
  try {
    return localStorage.getItem(FULLSCREEN_STORAGE_KEY) === 'on' ? 'on' : 'off'
  } catch {
    return 'off'
  }
}

export function useFullscreenReader(): [boolean, (next: boolean) => void] {
  const [value, update] = useStoredPreference(
    FULLSCREEN_STORAGE_KEY,
    readStoredFullscreen,
  )
  const set = useCallback(
    (next: boolean) => update(next ? 'on' : 'off'),
    [update],
  )
  return [value === 'on', set]
}

// ------------------------------------------------------- preference wiring --

/**
 * Listeners per storage key, so the same preference shown in two places — the
 * reader's gear and the settings page — cannot drift apart. `storage` only
 * fires in *other* tabs, which is why this tab notifies itself.
 */
const subscribers = new Map<string, Set<() => void>>()

function notify(key: string): void {
  subscribers.get(key)?.forEach((listener) => listener())
}

/** A string-valued preference in `localStorage`, shared across components. */
function useStoredPreference<T extends string>(
  key: string,
  read: () => T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(read)

  useEffect(() => {
    const listener = () => setValue(read())
    const listeners = subscribers.get(key) ?? new Set<() => void>()
    listeners.add(listener)
    subscribers.set(key, listeners)

    const onStorage = (event: StorageEvent) => {
      if (event.key === key || event.key === null) listener()
    }
    window.addEventListener('storage', onStorage)
    // Another component may have written between the initial read and here.
    listener()

    return () => {
      listeners.delete(listener)
      window.removeEventListener('storage', onStorage)
    }
  }, [key, read])

  const update = useCallback(
    (next: T) => {
      setValue(next)
      try {
        localStorage.setItem(key, next)
      } catch {
        // Private-mode storage refusal only costs the preference, not the read.
      }
      notify(key)
    },
    [key],
  )

  return [value, update]
}

export function isPagedMode(mode: ReaderMode): boolean {
  return mode !== 'continuous'
}

export function isRightToLeft(mode: ReaderMode): boolean {
  return mode === 'paged-rtl'
}

// ------------------------------------------------------- novel typography --

export interface TextReaderSettings {
  /** Body size in px. */
  fontSize: number
  /** Unitless multiple of the font size. */
  lineHeight: number
  /** Measure, in characters. Caps the column width whatever the window is. */
  width: number
  /** A `lib/fonts` catalog id, or `''` to read in whatever the app is wearing. */
  font: string
  justify: boolean
}

/**
 * What the two settings this used to have now mean.
 *
 * The choice was Serif or Sans before it was a catalog; Serif meant one
 * particular reading face, and Sans meant "the same as everything else". Both
 * still resolve to what they always looked like, so nobody's stored preference
 * changes under them.
 */
const LEGACY_FONTS: Record<string, string> = {
  serif: 'source-serif-4',
  sans: '',
}

function readStoredFont(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value in LEGACY_FONTS) return LEGACY_FONTS[value] ?? null
  // An id dropped from the catalog degrades to the app font rather than to a
  // family the browser will not find.
  if (value === '' || findFont(value)) return value
  return null
}

/**
 * Serif at a generous size and measure: this is a surface people read for an
 * hour at a time, and the defaults that suit a paragraph of UI copy are too
 * tight and too small for it.
 */
export const DEFAULT_TEXT_SETTINGS: TextReaderSettings = {
  fontSize: 19,
  lineHeight: 1.7,
  width: 68,
  font: 'source-serif-4',
  justify: false,
}

export const TEXT_SIZE_RANGE = { min: 12, max: 32 } as const
export const TEXT_LINE_HEIGHT_RANGE = { min: 1.2, max: 2.4 } as const
export const TEXT_WIDTH_RANGE = { min: 40, max: 120 } as const

const TEXT_STORAGE_KEY = 'kagi:reader-text'

function readStoredTextSettings(): TextReaderSettings {
  try {
    const raw = localStorage.getItem(TEXT_STORAGE_KEY)
    if (!raw) return DEFAULT_TEXT_SETTINGS
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return DEFAULT_TEXT_SETTINGS
    }
    // Field by field rather than a spread: a stored blob from an older build
    // can carry anything, and one bad value should not take the rest with it.
    const stored = parsed as Partial<Record<keyof TextReaderSettings, unknown>>
    return {
      fontSize: clampNumber(
        stored.fontSize,
        DEFAULT_TEXT_SETTINGS.fontSize,
        TEXT_SIZE_RANGE,
      ),
      lineHeight: clampNumber(
        stored.lineHeight,
        DEFAULT_TEXT_SETTINGS.lineHeight,
        TEXT_LINE_HEIGHT_RANGE,
      ),
      width: clampNumber(
        stored.width,
        DEFAULT_TEXT_SETTINGS.width,
        TEXT_WIDTH_RANGE,
      ),
      font: readStoredFont(stored.font) ?? DEFAULT_TEXT_SETTINGS.font,
      justify:
        typeof stored.justify === 'boolean'
          ? stored.justify
          : DEFAULT_TEXT_SETTINGS.justify,
    }
  } catch {
    return DEFAULT_TEXT_SETTINGS
  }
}

function clampNumber(
  value: unknown,
  fallback: number,
  range: { min: number; max: number },
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(range.max, Math.max(range.min, value))
}

export function useTextReaderSettings(): [
  TextReaderSettings,
  (patch: Partial<TextReaderSettings>) => void,
] {
  const [settings, setSettings] = useState<TextReaderSettings>(
    readStoredTextSettings,
  )

  const update = useCallback((patch: Partial<TextReaderSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch }
      try {
        localStorage.setItem(TEXT_STORAGE_KEY, JSON.stringify(next))
      } catch {
        // Private-mode storage refusal only costs the preference, not the read.
      }
      return next
    })
  }, [])

  return [settings, update]
}
