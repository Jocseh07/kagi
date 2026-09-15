/**
 * The app's text size, as a row of steps.
 *
 * Each label is drawn at the size it selects, so the row is its own preview
 * and nobody has to click through five options to find out what "Larger"
 * means. The type is set in `px` here on purpose: these labels are a ruler,
 * and a ruler that rescales with the thing it measures shows nothing.
 */

import { Button } from '@/components/ui/button'
import { TEXT_SIZE_OPTIONS } from '@/lib/display/text-size'
import { useTextSize } from '@/lib/display/use-text-size'
import { cn } from '@/lib/utils'

export function TextSizeChooser() {
  const [sizeId, setSize] = useTextSize()

  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Text size">
      {TEXT_SIZE_OPTIONS.map((option) => {
        const active = sizeId === option.id
        return (
          <Button
            key={option.id}
            variant={active ? 'secondary' : 'outline'}
            size="sm"
            role="radio"
            aria-checked={active}
            // The label is drawn at its own size, so a fixed control height
            // would clip the top of the row. The button grows with it.
            className={cn('h-auto py-1.5', active && 'border-ring')}
            onClick={() => setSize(option.id)}
          >
            <span style={{ fontSize: `${option.px}px`, lineHeight: 1.2 }}>
              {option.label}
            </span>
          </Button>
        )
      })}
    </div>
  )
}
