/**
 * The avatar colours.
 *
 * Fixed palette values rather than theme tokens on purpose: the accent is the
 * one thing on screen that stays yours across all 42 themes, so it must not be
 * repainted when a preset changes --primary. Each pair is chosen to hold its
 * contrast in both light and dark mode.
 */

export type AccentId = 'blue' | 'violet' | 'emerald' | 'amber' | 'rose' | 'slate'

export type Accent = {
  id: AccentId
  label: string
  /** Applied to the avatar fallback and the swatch alike. */
  className: string
}

export const ACCENTS: Accent[] = [
  { id: 'blue', label: 'Blue', className: 'bg-blue-500 text-white' },
  { id: 'violet', label: 'Violet', className: 'bg-violet-500 text-white' },
  { id: 'emerald', label: 'Emerald', className: 'bg-emerald-500 text-white' },
  { id: 'amber', label: 'Amber', className: 'bg-amber-500 text-amber-950' },
  { id: 'rose', label: 'Rose', className: 'bg-rose-500 text-white' },
  { id: 'slate', label: 'Slate', className: 'bg-slate-600 text-white' },
]

export const DEFAULT_ACCENT: AccentId = 'blue'

export function accentClass(id: string): string {
  const found = ACCENTS.find((accent) => accent.id === id)
  return (found ?? ACCENTS[0]).className
}
