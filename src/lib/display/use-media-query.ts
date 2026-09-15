import { useCallback, useSyncExternalStore } from 'react'

/**
 * Whether a viewport media query matches, kept in step with the stylesheet.
 *
 * `matchMedia` resolves the query exactly as Tailwind's breakpoints do, rem
 * conversion included, so a component can branch on the same edge its classes
 * step at. False on the server, where there is no viewport to ask.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )

  const read = useCallback(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
    [query],
  )

  return useSyncExternalStore(subscribe, read, () => false)
}
