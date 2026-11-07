import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'

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
 * the way back. A silent jump reads as a bug. Laid out by the caller, in the
 * column above the reader's bar.
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
      className="pointer-events-auto flex w-full max-w-xl items-center gap-2 rounded-xl border border-border bg-card py-1.5 pr-1.5 pl-3 shadow-lg"
    >
      <span className="min-w-0 flex-1 truncate text-sm">Resumed at {position}</span>
      <ToolbarButton variant="solid" className="h-10 px-3" onClick={onStartOver}>
        Start over
      </ToolbarButton>
      <ToolbarButton
        className="size-10 p-0"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={onDismiss}
      >
        <X aria-hidden className="size-4" />
      </ToolbarButton>
    </div>
  )
}
