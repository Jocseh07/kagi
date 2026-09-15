/**
 * The vocabulary of a theme.
 *
 * A theme is nothing but a set of CSS custom properties, so everything that
 * enters the app from outside — a vendored tweakcn preset, a pasted registry
 * item, a block of CSS off the tweakcn site — is filtered through the
 * allowlist and the value check below before it is ever written to a
 * stylesheet. Anything unrecognised is dropped rather than rejected, so a
 * theme carrying one token we do not model still imports.
 */

export type ThemeVars = Record<string, string>

export type ThemeTokens = {
  /** Mode-independent: fonts, radius, tracking. */
  theme?: ThemeVars
  light: ThemeVars
  dark: ThemeVars
}

export type ThemeSource = 'builtin' | 'tweakcn' | 'custom'

export type ThemePreset = {
  id: string
  title: string
  description?: string
  source: ThemeSource
  tokens: ThemeTokens
}

/**
 * Names accepted from an imported theme, without the leading `--`.
 *
 * The colour half is shadcn's token set; the rest is what tweakcn additionally
 * ships. `font-*`, `shadow-*`, `tracking-*`, `spacing` and `radius` are also
 * Tailwind theme variables, which is exactly why they work: declaring them on
 * a selector overrides Tailwind's own `:root` value and every utility built
 * from them re-resolves. See the note in index.css.
 */
export const ALLOWED_TOKENS: ReadonlySet<string> = new Set([
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  'input',
  'ring',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'sidebar',
  'sidebar-foreground',
  'sidebar-primary',
  'sidebar-primary-foreground',
  'sidebar-accent',
  'sidebar-accent-foreground',
  'sidebar-border',
  'sidebar-ring',
  'radius',
  'spacing',
  'font-sans',
  'font-serif',
  'font-mono',
  'letter-spacing',
  'tracking-normal',
  'tracking-tighter',
  'tracking-tight',
  'tracking-wide',
  'tracking-wider',
  'tracking-widest',
  'shadow-color',
  'shadow-opacity',
  'shadow-blur',
  'shadow-spread',
  'shadow-offset-x',
  'shadow-offset-y',
  'shadow-2xs',
  'shadow-xs',
  'shadow-sm',
  'shadow',
  'shadow-md',
  'shadow-lg',
  'shadow-xl',
  'shadow-2xl',
])

/**
 * A declaration value has to survive leaving the stylesheet it came from.
 *
 * `;` and `}` would end the declaration and let the rest of the string be read
 * as new rules; `@` would open an at-rule; `url()` and `expression()` would
 * reach back out to the network or to script. Rejecting the value outright is
 * better than escaping it — no legitimate theme token needs any of them.
 */
export function isSafeTokenValue(value: string): boolean {
  if (value.length === 0 || value.length > 300) return false
  if (/[;{}@\\<>]/.test(value)) return false
  if (/url\s*\(|expression\s*\(|image-set\s*\(/i.test(value)) return false
  return true
}

/** Keeps the recognised, safe entries and discards the rest. */
export function sanitizeVars(input: unknown): ThemeVars {
  const out: ThemeVars = {}
  if (!input || typeof input !== 'object') return out

  for (const [rawKey, rawValue] of Object.entries(input as object)) {
    if (typeof rawValue !== 'string') continue
    const key = rawKey.replace(/^--/, '').trim()
    const value = rawValue.trim()
    if (!ALLOWED_TOKENS.has(key)) continue
    if (!isSafeTokenValue(value)) continue
    out[key] = value
  }

  return out
}

export function sanitizeTokens(input: unknown): ThemeTokens {
  const source = (input ?? {}) as Partial<Record<keyof ThemeTokens, unknown>>
  return {
    theme: sanitizeVars(source.theme),
    light: sanitizeVars(source.light),
    dark: sanitizeVars(source.dark),
  }
}

export function hasAnyToken(tokens: ThemeTokens): boolean {
  return (
    Object.keys(tokens.light).length > 0 ||
    Object.keys(tokens.dark).length > 0 ||
    Object.keys(tokens.theme ?? {}).length > 0
  )
}

/** Lower-cases, strips punctuation and dedupes against ids already taken. */
export function slugify(title: string, taken: ReadonlySet<string> = new Set()): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'theme'

  if (!taken.has(base)) return base
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}
