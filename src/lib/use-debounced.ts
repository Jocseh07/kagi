import { useEffect, useState } from 'react'

/**
 * A value that settles only once it has stopped changing for `delay` ms.
 *
 * Keeps a text input responsive while the work it drives — a query, or a pass
 * over a long list — waits for the typing to stop.
 */
export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])

  return debounced
}
