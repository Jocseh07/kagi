import { useEffect, useMemo } from 'react'

import type { ComboboxOption } from '@/components/ui/combobox'
import { FONTS } from '@/lib/fonts/model'
import { useCustomFonts } from '@/lib/fonts/custom'
import { ensureFontLoaded } from '@/lib/fonts/load'

/**
 * The catalog and the fonts added on this device as combobox rows, each
 * previewed in the face it names.
 *
 * `defaultLabel` names the row that clears the override: the app's font in the
 * reader, the theme's in settings.
 */
export function useFontOptions(defaultLabel: string): ComboboxOption[] {
  const custom = useCustomFonts()

  useEffect(() => custom.forEach(ensureFontLoaded), [custom])

  return useMemo(
    () => [
      { value: '', label: defaultLabel, style: { fontFamily: 'var(--font-sans)' } },
      ...[...custom, ...FONTS].map((font) => ({
        value: font.id,
        label: font.name,
        style: { fontFamily: font.stack },
      })),
    ],
    [custom, defaultLabel],
  )
}
