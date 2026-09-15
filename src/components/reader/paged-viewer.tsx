import type { MouseEvent } from 'react'

import type { Page } from '@/lib/sources/types'

import { ReaderPage } from './reader-page'

interface PagedViewerProps {
  page: Page
  total: number
  rightToLeft: boolean
  onPrevious(): void
  onNext(): void
}

export function PagedViewer({
  page,
  total,
  rightToLeft,
  onPrevious,
  onNext,
}: PagedViewerProps) {
  const onLeftEdge = rightToLeft ? onNext : onPrevious
  const onRightEdge = rightToLeft ? onPrevious : onNext

  // There is nothing to scroll here, so the middle of the page is the only way
  // to toggle the chrome; the edges must stay page turns and nothing else.
  const turnPage = (turn: () => void) => (event: MouseEvent) => {
    event.stopPropagation()
    turn()
  }

  return (
    <div className="relative h-full w-full overflow-hidden">
      <ReaderPage key={page.index} page={page} total={total} fit="screen" />

      <button
        type="button"
        aria-label={rightToLeft ? 'Next page' : 'Previous page'}
        onClick={turnPage(onLeftEdge)}
        className="absolute inset-y-0 left-0 w-1/3 cursor-w-resize focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      />
      <button
        type="button"
        aria-label={rightToLeft ? 'Previous page' : 'Next page'}
        onClick={turnPage(onRightEdge)}
        className="absolute inset-y-0 right-0 w-1/3 cursor-e-resize focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      />
    </div>
  )
}
