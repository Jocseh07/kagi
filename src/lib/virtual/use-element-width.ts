import { useLayoutEffect, useState } from 'react'

/**
 * The element's content width, tracked as it changes.
 *
 * Used to estimate a grid row's height before the row exists: the card is a
 * fixed aspect ratio, so its width decides everything. Zero until measured,
 * which callers should read as "no estimate yet".
 */
export function useElementWidth(element: HTMLElement | null): number {
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    if (!element) return

    const measure = () => {
      const next = Math.round(element.clientWidth)
      setWidth((current) => (current === next ? current : next))
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])

  return width
}
