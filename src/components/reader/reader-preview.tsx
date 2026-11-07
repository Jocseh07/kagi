import type { CSSProperties } from 'react'

import { useFontStack } from '@/lib/fonts/load'
import { cn } from '@/lib/utils'

import {
  readerSurfaceStyle,
  useReaderSurface,
  useTextReaderSettings,
} from '@/lib/reader/reader-settings'

/**
 * A few lines set exactly as the novel reader sets them, on the page colour it
 * would wear, so a change to any control beside it shows before a chapter is
 * opened. The prose style mirrors text-viewer.tsx; keep the two in step.
 */
export function ReaderPreview({ className }: { className?: string }) {
  const [surface] = useReaderSurface()
  const [text] = useTextReaderSettings()
  const skin = readerSurfaceStyle(surface)
  const fontFamily = useFontStack(text.font)

  const prose: CSSProperties = {
    fontSize: `${text.fontSize}px`,
    lineHeight: text.lineHeight,
    maxWidth: `${text.width}ch`,
    textAlign: text.justify ? 'justify' : 'start',
    fontFamily,
    hyphens: text.justify ? 'auto' : 'manual',
  }

  return (
    <figure className={cn('m-0 flex flex-col gap-2', className)}>
      <figcaption className="px-1 text-sm font-medium">Preview</figcaption>
      <div
        lang="en"
        className={cn(
          skin.className,
          'overflow-hidden rounded-lg border border-border bg-background px-4 py-4 text-foreground',
        )}
        style={skin.style}
      >
        <div style={prose}>
          <p>
            The lanterns were already out when the village woke, and the road
            to the pass lay quiet under new snow.
          </p>
        </div>
        <p className="mt-3 text-xs text-muted-foreground tabular-nums">Page 3 of 21</p>
      </div>
    </figure>
  )
}
