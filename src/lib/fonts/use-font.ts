/**
 * Which font the app is wearing.
 *
 * Selecting is synchronous, like picking a theme: the catalog is a constant and
 * the change is one style write, so the type changes on the same frame as the
 * click. Null means "whatever the theme says".
 */

import { useCallback, useState } from 'react'

import { applyFont, readActiveFontId } from '@/lib/fonts/store'

export function useFont(): [string | null, (id: string | null) => void] {
  const [fontId, setFontId] = useState<string | null>(readActiveFontId)

  const select = useCallback((id: string | null) => {
    applyFont(id)
    setFontId(id)
  }, [])

  return [fontId, select]
}
