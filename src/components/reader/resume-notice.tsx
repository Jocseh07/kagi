import { useEffect, useRef } from 'react'

import { ToolbarButton } from './ui'

const DISMISS_AFTER_MS = 6000

interface ResumeNoticeProps {
  /**
   * Where the chapter resumed, already worded by the caller — "page 12" for a
   * comic, "42%" for a novel, which has no pages to count.
   */
  position: string
  onStartOver(): void
  onDismiss(): void
}

/**
 * Tells the reader why the chapter did not open at the beginning, and offers
 * the way back. A silent jump reads as a bug.
 */
export function ResumeNotice({
  position,
  onStartOver,
  onDismiss,
}: ResumeNoticeProps) {
  const dismiss = useRef(onDismiss)
  useEffect(() => {
    dismiss.current = onDismiss
  }, [onDismiss])

  // Armed once, on mount. Callers pass an inline `onDismiss`, so depending on
  // it directly would restart the countdown on every render of the reader —
  // and a reader that is being scrolled renders constantly.
  useEffect(() => {
    const timer = setTimeout(() => dismiss.current(), DISMISS_AFTER_MS)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div
      role="status"
      className="pointer-events-none absolute inset-x-0 bottom-[calc(1rem+env(safe-area-inset-bottom))] flex justify-center px-4"
    >
      <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-1.5 shadow-lg">
        <span className="text-xs text-muted-foreground">
          Resumed at {position}
        </span>
        <ToolbarButton variant="solid" className="h-6 px-2" onClick={onStartOver}>
          Start over
        </ToolbarButton>
        <ToolbarButton
          className="h-6 px-2"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          Dismiss
        </ToolbarButton>
      </div>
    </div>
  )
}
