import { useSyncExternalStore } from 'react'

import type { FontOption } from '@/lib/fonts/model'

export const CUSTOM_FONTS_KEY = 'kagi:custom-fonts'
export const GOOGLE_FONT_PREFIX = 'gf:'

const NAME_PATTERN = /^[A-Za-z0-9 ]{2,60}$/
const GOOGLE_FONTS_CSS = 'https://fonts.googleapis.com/css2'
// Richest first; Google answers 400 for any weight or style a family lacks.
const AXES = ['ital,wght@0,400;0,700;1,400', 'wght@400;700', '']

export class FontNotFoundError extends Error {
  constructor(name: string) {
    super(`No Google font named ${name}`)
    this.name = 'FontNotFoundError'
  }
}

export function normalizeFontName(name: string): string | null {
  const trimmed = name.trim().replace(/\s+/g, ' ')
  return NAME_PATTERN.test(trimmed) ? trimmed : null
}

export function googleFontsHref(name: string, axes = ''): string {
  const family = name.replace(/ /g, '+')
  return `${GOOGLE_FONTS_CSS}?family=${family}${axes ? `:${axes}` : ''}&display=swap`
}

export function googleFont(name: string, href = googleFontsHref(name)): FontOption {
  return {
    id: `${GOOGLE_FONT_PREFIX}${name}`,
    name,
    stack: `'${name}', sans-serif`,
    href,
  }
}

const NO_FONTS: FontOption[] = []
const listeners = new Set<() => void>()
let cache: { raw: string | null; fonts: FontOption[] } = { raw: null, fonts: [] }

function readRaw(): string | null {
  try {
    return globalThis.localStorage?.getItem(CUSTOM_FONTS_KEY) ?? null
  } catch {
    return null
  }
}

export function readCustomFonts(): FontOption[] {
  const raw = readRaw()
  if (raw === cache.raw) return cache.fonts

  let fonts: FontOption[] = []
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (Array.isArray(parsed)) {
      fonts = parsed.flatMap((entry: Partial<FontOption>) => {
        const name = typeof entry?.name === 'string' ? normalizeFontName(entry.name) : null
        if (!name) return []
        return [googleFont(name, typeof entry.href === 'string' ? entry.href : undefined)]
      })
    }
  } catch {
    fonts = []
  }
  cache = { raw, fonts }
  return fonts
}

function writeCustomFonts(fonts: FontOption[]): void {
  try {
    globalThis.localStorage?.setItem(
      CUSTOM_FONTS_KEY,
      JSON.stringify(fonts.map(({ name, href }) => ({ name, href }))),
    )
  } catch {
    // Storage refused; the list lives until reload.
    cache = { raw: cache.raw, fonts }
  }
  listeners.forEach((listener) => listener())
}

async function probe(name: string): Promise<string> {
  for (const axes of AXES) {
    const href = googleFontsHref(name, axes)
    const response = await fetch(href)
    if (response.ok) return href
    if (response.status !== 400) throw new Error(`Google Fonts answered ${response.status}`)
  }
  throw new FontNotFoundError(name)
}

/** The family as Google Fonts serves it, or FontNotFoundError. */
export async function findGoogleFont(input: string): Promise<FontOption> {
  const name = normalizeFontName(input)
  if (!name) throw new FontNotFoundError(input)

  const existing = readCustomFonts().find((font) => font.name.toLowerCase() === name.toLowerCase())
  if (existing) return existing

  try {
    return googleFont(name, await probe(name))
  } catch (error) {
    // Google matches family names case-sensitively; most are title case.
    const titled = name.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    if (!(error instanceof FontNotFoundError) || titled === name) throw error
    return googleFont(titled, await probe(titled))
  }
}

export function keepCustomFont(font: FontOption): void {
  const fonts = readCustomFonts()
  if (fonts.some((entry) => entry.id === font.id)) return
  writeCustomFonts([...fonts, font])
}

export function removeCustomFont(id: string): void {
  writeCustomFonts(readCustomFonts().filter((font) => font.id !== id))
}

export function restoreCustomFont(font: FontOption, index: number): void {
  const fonts = readCustomFonts().filter((entry) => entry.id !== font.id)
  fonts.splice(Math.min(index, fonts.length), 0, font)
  writeCustomFonts(fonts)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useCustomFonts(): FontOption[] {
  return useSyncExternalStore(subscribe, readCustomFonts, () => NO_FONTS)
}
