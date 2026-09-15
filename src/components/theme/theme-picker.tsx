/**
 * The theme grid.
 *
 * Each card previews a theme in the mode that is currently showing, so what
 * you see on the card is what the app will look like a click later. Applying
 * is synchronous — the preset is already in memory — which is why there is no
 * pending state anywhere in here.
 */

import { Check, Copy, Pencil, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { swatchColors } from '@/lib/theme/css'
import { resolveTheme, useTheme } from '@/lib/theme/mode'
import type { ThemePreset } from '@/lib/theme/tokens'
import { cn } from '@/lib/utils'

type ThemeCardProps = {
  preset: ThemePreset
  mode: 'light' | 'dark'
  active: boolean
  onSelect: () => void
  onCopy?: () => void
  onRename?: () => void
  onDelete?: () => void
}

function ThemeCard({
  preset,
  mode,
  active,
  onSelect,
  onCopy,
  onRename,
  onDelete,
}: ThemeCardProps) {
  const colors = swatchColors(preset.tokens, mode)

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        title={preset.description ?? preset.title}
        className={cn(
          'flex w-full flex-col gap-2 rounded-lg border p-2.5 text-left transition-colors',
          'hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
          active ? 'border-ring bg-accent/40' : 'border-border',
        )}
      >
        <span className="flex items-center gap-1" aria-hidden>
          {colors.map((color, index) => (
            <span
              key={index}
              className="size-4 rounded-full border border-border/60"
              style={{ backgroundColor: color }}
            />
          ))}
        </span>

        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium">{preset.title}</span>
          {active ? <Check className="size-3.5 shrink-0 text-muted-foreground" /> : null}
        </span>
      </button>

      {onCopy || onRename || onDelete ? (
        <span className="absolute right-1.5 top-1.5 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {onCopy ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={`Copy ${preset.title} as JSON`}
              onClick={onCopy}
            >
              <Copy className="size-3.5" />
            </Button>
          ) : null}
          {onRename ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={`Rename ${preset.title}`}
              onClick={onRename}
            >
              <Pencil className="size-3.5" />
            </Button>
          ) : null}
          {onDelete ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-destructive"
              aria-label={`Delete ${preset.title}`}
              onClick={onDelete}
            >
              <Trash2 className="size-3.5" />
            </Button>
          ) : null}
        </span>
      ) : null}
    </div>
  )
}

type ThemePickerProps = {
  presets: ThemePreset[]
  activeId: string
  onSelect: (preset: ThemePreset) => void
  onCopy?: (preset: ThemePreset) => void
  onRename?: (preset: ThemePreset) => void
  onDelete?: (preset: ThemePreset) => void
}

export function ThemePicker({
  presets,
  activeId,
  onSelect,
  onCopy,
  onRename,
  onDelete,
}: ThemePickerProps) {
  const [theme] = useTheme()
  const mode = resolveTheme(theme)

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {presets.map((preset) => (
        <ThemeCard
          key={preset.id}
          preset={preset}
          mode={mode}
          active={preset.id === activeId}
          onSelect={() => onSelect(preset)}
          onCopy={onCopy ? () => onCopy(preset) : undefined}
          onRename={onRename ? () => onRename(preset) : undefined}
          onDelete={onDelete ? () => onDelete(preset) : undefined}
        />
      ))}
    </div>
  )
}
