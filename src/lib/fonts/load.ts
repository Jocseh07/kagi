import { useEffect } from 'react'

import { findFont } from '@/lib/fonts/catalog'
import type { FontOption } from '@/lib/fonts/model'

/** fonts.css carries the catalog; a Google family needs its stylesheet linked once. */
export function ensureFontLoaded(font: FontOption | null): void {
  if (!font?.href || typeof document === 'undefined') return
  const id = `font-${font.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
  if (document.getElementById(id)) return

  const link = document.createElement('link')
  link.id = id
  link.rel = 'stylesheet'
  link.href = font.href
  document.head.append(link)
}

/** The stack to paint with, loading a Google family on the way. */
export function useFontStack(id: string | null): string | undefined {
  useEffect(() => ensureFontLoaded(findFont(id)), [id])
  return findFont(id)?.stack
}
