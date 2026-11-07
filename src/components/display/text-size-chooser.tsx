/**
 * The app's text size, as a row of steps.
 *
 * Each step is drawn at the size it selects, so the row is its own preview
 * and nobody has to click through five options to find out what "Larger"
 * means. The type is set in `px` here on purpose: these labels are a ruler,
 * and a ruler that rescales with the thing it measures shows nothing.
 */

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { TEXT_SIZE_OPTIONS } from '@/lib/display/text-size'
import { useTextSize } from '@/lib/display/use-text-size'

export function TextSizeChooser() {
  const [sizeId, setSize] = useTextSize()

  return (
    <ToggleGroup
      type="single"
      aria-label="Text size"
      value={sizeId}
      onValueChange={(value) => {
        if (value) setSize(value as typeof sizeId)
      }}
      className="grid w-full grid-cols-5 @md:w-auto"
    >
      {TEXT_SIZE_OPTIONS.map((option) => (
        <ToggleGroupItem
          key={option.id}
          value={option.id}
          aria-label={option.label}
          title={option.label}
          className="h-10"
        >
          <span aria-hidden style={{ fontSize: `${option.px}px`, lineHeight: 1 }}>
            Aa
          </span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
