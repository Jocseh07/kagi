import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { AdaptStyle } from '@/lib/adapt/store'

const STYLES: readonly { value: AdaptStyle; label: string; hint: string }[] = [
  { value: 'webtoon', label: 'Webtoon', hint: 'Full colour' },
  { value: 'manga', label: 'Manga', hint: 'Black and white' },
  { value: 'sketch', label: 'Sketch', hint: 'Rough pencil' },
]

export function StylePicker({
  value,
  onChange,
}: {
  value: AdaptStyle
  onChange(value: AdaptStyle): void
}) {
  return (
    <ToggleGroup
      type="single"
      aria-label="Art style"
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as AdaptStyle)
      }}
      className="grid w-full grid-cols-3"
    >
      {STYLES.map((style) => (
        <ToggleGroupItem
          key={style.value}
          value={style.value}
          className="h-auto flex-col gap-0.5 py-2 font-normal text-muted-foreground data-[state=on]:text-foreground"
        >
          <span className="text-sm font-medium">{style.label}</span>
          <span className="text-xs">{style.hint}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
