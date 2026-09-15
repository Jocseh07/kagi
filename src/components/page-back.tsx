import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

/**
 * Where "back" goes from the page currently on screen.
 *
 * The header is mounted once by the root layout, so a route cannot render into
 * it directly. It publishes a target here instead and the header picks it up.
 */
export interface PageBack {
  to: string
  params?: Record<string, string>
  label: string
}

interface PageBackStore {
  back: PageBack | null
  setBack(next: PageBack | null): void
}

const PageBackContext = createContext<PageBackStore>({
  back: null,
  setBack: () => undefined,
})

export function PageBackProvider({ children }: { children: ReactNode }) {
  const [back, setBack] = useState<PageBack | null>(null)
  const value = useMemo(() => ({ back, setBack }), [back])

  return (
    <PageBackContext.Provider value={value}>
      {children}
    </PageBackContext.Provider>
  )
}

/**
 * Publishes this page's back target for as long as it is mounted. Pass a
 * memoised object: an inline literal is a new value on every render and would
 * loop the effect.
 */
export function usePageBack(back: PageBack | null): void {
  const { setBack } = useContext(PageBackContext)

  useEffect(() => {
    setBack(back)
    return () => setBack(null)
  }, [setBack, back])
}

export function usePageBackValue(): PageBack | null {
  return useContext(PageBackContext).back
}
