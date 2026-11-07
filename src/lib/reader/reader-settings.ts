import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

import { findFont } from '@/lib/fonts/catalog'
import type { WordStartStrength } from '@/lib/text/word-starts'

import { onStorageChange } from './storage-events'

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

// ---------------------------------------------------------------- idle dim --

const DIM_IDLE_STORAGE_KEY = 'kagi:reader-dim-idle'

/** Idle time before the reader fades down and lets the screen lock. */
export const DIM_AFTER_MS = 20_000

function readStoredDimIdle(): 'on' | 'off' {
  try {
    return localStorage.getItem(DIM_IDLE_STORAGE_KEY) === 'on' ? 'on' : 'off'
  } catch {
    return 'off'
  }
}

export function useIdleDim(): [boolean, (next: boolean) => void] {
  const [value, update] = useStoredPreference(
    DIM_IDLE_STORAGE_KEY,
    readStoredDimIdle,
  )
  const set = useCallback(
    (next: boolean) => update(next ? 'on' : 'off'),
    [update],
  )
  return [value === 'on', set]
}

// ------------------------------------------------------------ page layout --
// Read by the native reader only; the web strip is always a seamless webtoon.

/** A comic page sized to the column's width, or whole within the screen. */
export type PageFit = 'width' | 'screen'

export const PAGE_FITS: { value: PageFit; label: string }[] = [
  { value: 'width', label: 'Width' },
  { value: 'screen', label: 'Screen' },
]

const FIT_STORAGE_KEY = 'kagi:reader-fit'

function readStoredFit(): PageFit {
  try {
    return localStorage.getItem(FIT_STORAGE_KEY) === 'screen' ? 'screen' : 'width'
  } catch {
    return 'width'
  }
}

export function usePageFit(): [PageFit, (next: PageFit) => void] {
  return useStoredPreference(FIT_STORAGE_KEY, readStoredFit)
}

/** Continuous mode as separate pages, or as one edge-to-edge webtoon strip. */
export type ContinuousStyle = 'vertical' | 'webtoon'

const CONTINUOUS_STYLE_STORAGE_KEY = 'kagi:reader-continuous-style'

function readStoredContinuousStyle(): ContinuousStyle {
  try {
    return localStorage.getItem(CONTINUOUS_STYLE_STORAGE_KEY) === 'vertical'
      ? 'vertical'
      : 'webtoon'
  } catch {
    return 'webtoon'
  }
}

export function useContinuousStyle(): [
  ContinuousStyle,
  (next: ContinuousStyle) => void,
] {
  return useStoredPreference(
    CONTINUOUS_STYLE_STORAGE_KEY,
    readStoredContinuousStyle,
  )
}

const PAGE_GAP_STORAGE_KEY = 'kagi:reader-page-gap'

function readStoredPageGap(): 'on' | 'off' {
  try {
    return localStorage.getItem(PAGE_GAP_STORAGE_KEY) === 'off' ? 'off' : 'on'
  } catch {
    return 'on'
  }
}

export function usePageGap(): [boolean, (next: boolean) => void] {
  const [value, update] = useStoredPreference(
    PAGE_GAP_STORAGE_KEY,
    readStoredPageGap,
  )
  const set = useCallback(
    (next: boolean) => update(next ? 'on' : 'off'),
    [update],
  )
  return [value === 'on', set]
}

// ------------------------------------------------------------- background --

export type ReaderSurface = 'dark' | 'muted' | 'black' | 'app'

export const READER_SURFACES: {
  value: ReaderSurface
  label: string
  hint: string
}[] = [
  { value: 'dark', label: 'Dark', hint: "The theme's dark page colour." },
  {
    value: 'muted',
    label: 'Muted',
    hint: 'A softer surface, one step off the page.',
  },
  { value: 'black', label: 'Black', hint: 'True black, for OLED screens.' },
  {
    value: 'app',
    label: 'Follow the app',
    hint: 'Light or dark, whichever the app is in.',
  },
]

// Dark is what the reader has always been; nobody's reader changes on upgrade.
const DEFAULT_SURFACE: ReaderSurface = 'dark'
const SURFACE_STORAGE_KEY = 'kagi:reader-surface'

function isReaderSurface(value: unknown): value is ReaderSurface {
  return (
    value === 'dark' ||
    value === 'muted' ||
    value === 'black' ||
    value === 'app'
  )
}

function readStoredSurface(): ReaderSurface {
  try {
    const stored = localStorage.getItem(SURFACE_STORAGE_KEY)
    return isReaderSurface(stored) ? stored : DEFAULT_SURFACE
  } catch {
    return DEFAULT_SURFACE
  }
}

export function useReaderSurface(): [
  ReaderSurface,
  (next: ReaderSurface) => void,
] {
  return useStoredPreference(SURFACE_STORAGE_KEY, readStoredSurface)
}

/**
 * What the reader root wears for a surface: a palette class and a background.
 *
 * The surface arrives as a `--background` override rather than a different
 * `bg-*` utility, so the root keeps `bg-background text-foreground` — the
 * pairing rule holds — and every descendant reading `--background` follows.
 */
export function readerSurfaceStyle(surface: ReaderSurface): {
  className: string
  style: CSSProperties
} {
  switch (surface) {
    case 'muted':
      return {
        className: 'dark',
        style: { '--background': 'var(--muted)' } as CSSProperties,
      }
    case 'black':
      return {
        className: 'dark',
        style: { '--background': 'var(--color-letterbox)' } as CSSProperties,
      }
    case 'app':
      return { className: '', style: {} }
    default:
      return { className: 'dark', style: {} }
  }
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

    const stopStorage = onStorageChange(key, listener)
    // Another component may have written between the initial read and here.
    listener()

    return () => {
      listeners.delete(listener)
      stopStorage()
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

/** An object-valued preference in `localStorage`, shared across components. */
function useStoredRecord<T>(
  key: string,
  read: () => T,
): [T, (patch: Partial<T>) => void] {
  const [value, setValue] = useState<T>(read)
  /**
   * The current value, readable outside render. `update` has to serialize the
   * merged result, which a `setState` updater cannot hand back — and writing
   * storage inside an updater would be a side effect React may run twice.
   */
  const current = useRef(value)

  useEffect(() => {
    const listener = () => {
      const next = read()
      current.current = next
      setValue(next)
    }
    const listeners = subscribers.get(key) ?? new Set<() => void>()
    listeners.add(listener)
    subscribers.set(key, listeners)

    const stopStorage = onStorageChange(key, listener)
    // Another component may have written between the initial read and here.
    listener()

    return () => {
      listeners.delete(listener)
      stopStorage()
    }
  }, [key, read])

  const update = useCallback(
    (patch: Partial<T>) => {
      const next = { ...current.current, ...patch }
      current.current = next
      setValue(next)
      try {
        localStorage.setItem(key, JSON.stringify(next))
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

/** Whether every novel text setting is at its default, so Reset has nothing to do. */
export function isDefaultTextSettings(text: TextReaderSettings): boolean {
  return (Object.keys(DEFAULT_TEXT_SETTINGS) as (keyof TextReaderSettings)[]).every(
    (key) => text[key] === DEFAULT_TEXT_SETTINGS[key],
  )
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
  return useStoredRecord(TEXT_STORAGE_KEY, readStoredTextSettings)
}

// ------------------------------------------------------ bold word starts --

export interface WordStartsSettings {
  enabled: boolean
  strength: WordStartStrength
}

export const WORD_START_STRENGTHS: { value: WordStartStrength; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'medium', label: 'Medium' },
  { value: 'strong', label: 'Strong' },
]

// A reading aid, not typography: kept out of the text settings so Reset leaves it alone.
const DEFAULT_WORD_STARTS: WordStartsSettings = { enabled: false, strength: 'medium' }
const WORD_STARTS_STORAGE_KEY = 'kagi:reader-word-starts'

function isWordStartStrength(value: unknown): value is WordStartStrength {
  return value === 'light' || value === 'medium' || value === 'strong'
}

function readStoredWordStarts(): WordStartsSettings {
  try {
    const raw = localStorage.getItem(WORD_STARTS_STORAGE_KEY)
    if (!raw) return DEFAULT_WORD_STARTS
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_WORD_STARTS
    const stored = parsed as Partial<Record<keyof WordStartsSettings, unknown>>
    return {
      enabled:
        typeof stored.enabled === 'boolean'
          ? stored.enabled
          : DEFAULT_WORD_STARTS.enabled,
      strength: isWordStartStrength(stored.strength)
        ? stored.strength
        : DEFAULT_WORD_STARTS.strength,
    }
  } catch {
    return DEFAULT_WORD_STARTS
  }
}

export function useWordStarts(): [
  WordStartsSettings,
  (patch: Partial<WordStartsSettings>) => void,
] {
  return useStoredRecord(WORD_STARTS_STORAGE_KEY, readStoredWordStarts)
}
