import { createContext, use } from 'react'
import type { ReactNode } from 'react'

/**
 * The element every page scrolls inside.
 *
 * Pages do not own their scroller: the root lays out one `<main>` that scrolls,
 * and each route renders its heading, filters and list into it. A virtualizer
 * therefore has to be handed that element from above, and has to account for
 * whatever the page drew above its list — see `usePageVirtualizer`.
 *
 * The element itself rather than a ref, so that a list mounting before the
 * scroller's ref is attached re-renders once the element exists. A ref would
 * still read null on the first pass and nothing would tell the list to look
 * again.
 */
const ScrollElementContext = createContext<HTMLElement | null>(null)

export function ScrollElementProvider({
  value,
  children,
}: {
  value: HTMLElement | null
  children: ReactNode
}) {
  return <ScrollElementContext value={value}>{children}</ScrollElementContext>
}

/** Null until the app shell has mounted, and outside it altogether. */
export function useScrollElement(): HTMLElement | null {
  return use(ScrollElementContext)
}
