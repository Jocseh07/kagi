import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { DesktopNavBridge, DesktopNavState } from '@/lib/adapt/desktop-bridge'

/** Window history controls for the Electron shell, which has no browser chrome. Absent in a browser. */
export function DesktopNav() {
  const [nav, setNav] = useState<DesktopNavBridge | null>(null)
  const [state, setState] = useState<DesktopNavState>({ canGoBack: false, canGoForward: false })

  useEffect(() => {
    const bridge = window.kagiDesktop?.nav
    if (!bridge) return
    setNav(bridge)
    void bridge.state().then(setState)
    return bridge.onChange(setState)
  }, [])

  if (!nav) return null

  return (
    <nav
      aria-label="History"
      className="absolute bottom-4 left-4 z-40 flex gap-1 rounded-lg border border-border bg-card p-1 shadow-md"
    >
      <Button type="button" variant="ghost" size="icon" aria-label="Back" disabled={!state.canGoBack} onClick={() => nav.back()}>
        <ChevronLeft />
      </Button>
      <Button type="button" variant="ghost" size="icon" aria-label="Forward" disabled={!state.canGoForward} onClick={() => nav.forward()}>
        <ChevronRight />
      </Button>
    </nav>
  )
}
