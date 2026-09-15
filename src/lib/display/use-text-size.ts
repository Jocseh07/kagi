/**
 * How big the app is wearing itself.
 *
 * Synchronous, like the font and the theme: the table is a constant and the
 * change is one style write, so the app resizes on the same frame as the click.
 */

import { useCallback, useState } from 'react'

import {
  applyTextSize,
  readActiveTextSizeId,
  type TextSizeId,
} from '@/lib/display/text-size'

export function useTextSize(): [TextSizeId, (id: TextSizeId) => void] {
  const [sizeId, setSizeId] = useState<TextSizeId>(readActiveTextSizeId)

  const select = useCallback((id: TextSizeId) => {
    applyTextSize(id)
    setSizeId(id)
  }, [])

  return [sizeId, select]
}
