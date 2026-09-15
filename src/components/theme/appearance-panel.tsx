/**
 * The Appearance tab: one row per choice, in the same shape as the Reader and
 * Library tabs. The theme grid is large enough to be a dialog of its own.
 */

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Palette } from 'lucide-react'

import { FontPicker } from '@/components/fonts/font-picker'
import { TextSizeChooser } from '@/components/display/text-size-chooser'
import { ModeChooser } from '@/components/theme/mode-chooser'
import { ThemeDialog } from '@/components/theme/theme-dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useDatabaseReady } from '@/lib/db/provider'
import { getFlag, setFlag } from '@/lib/db/repositories'
import {
  SETTING_COMPACT_LIST,
  compactListQueryKey,
} from '@/lib/display/compact'
import { swatchColors } from '@/lib/theme/css'
import { resolveTheme, useTheme } from '@/lib/theme/mode'
import { useThemePresets } from '@/lib/theme/use-theme-presets'

export function AppearancePanel() {
  const themes = useThemePresets()
  const [choosing, setChoosing] = useState(false)
  const [mode] = useTheme()
  const resolved = resolveTheme(mode)

  const active = useMemo(
    () =>
      [...themes.custom, ...themes.builtIn].find((p) => p.id === themes.activeId) ?? null,
    [themes.custom, themes.builtIn, themes.activeId],
  )
  const swatches = active ? swatchColors(active.tokens, resolved) : []

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">Appearance</h2>
        <span className="text-xs text-muted-foreground">Kept on this device</span>
      </header>

      <div className="divide-y divide-border">
        <Row
          label="Theme"
          hint="Colours for both light and dark."
          control={
            <Button
              variant="outline"
              size="sm"
              onClick={() => setChoosing(true)}
              aria-haspopup="dialog"
            >
              {swatches.length > 0 ? (
                <span className="flex items-center gap-0.5" aria-hidden>
                  {swatches.map((color, index) => (
                    <span
                      key={index}
                      className="size-3 rounded-full border border-border/60"
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </span>
              ) : (
                <Palette />
              )}
              <span className="max-w-40 truncate">{active?.title ?? 'Choose'}</span>
            </Button>
          }
        />

        <Row
          label="Mode"
          hint="Light, dark, or follow the system."
          control={<ModeChooser />}
        />

        <Row
          label="Text size"
          hint="Scales the whole interface, spacing included."
          control={<TextSizeChooser />}
        />

        <Row
          label="Font"
          hint="Overrides the theme's own font."
          control={<FontPicker />}
        />

        <CompactListSetting />
      </div>

      <ThemeDialog open={choosing} onOpenChange={setChoosing} themes={themes} />
    </section>
  )
}

/**
 * Label and hint on the left, control on the right from `sm` up. Below that
 * the control drops under the label: the mode and size choosers are wider
 * than half a phone.
 */
function Row({
  label,
  hint,
  control,
}: {
  label: string
  hint: string
  control: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  )
}

/**
 * Density, not decoration, but it belongs beside mode and font because it is
 * the same kind of choice: how the app looks, kept on this device.
 */
function CompactListSetting() {
  const ready = useDatabaseReady()
  const queryClient = useQueryClient()

  const stored = useQuery({
    queryKey: compactListQueryKey,
    queryFn: () => getFlag(SETTING_COMPACT_LIST),
    enabled: ready,
    staleTime: Infinity,
  })

  const save = useMutation({
    mutationFn: (value: boolean) => setFlag(SETTING_COMPACT_LIST, value),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: compactListQueryKey }),
  })

  // The refetch confirming the write lags the press, so show the press.
  const on = save.isPending ? save.variables : (stored.data ?? false)

  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label htmlFor="compact-list" className="font-normal">
          Compact list view
        </Label>
        <p className="text-xs text-muted-foreground">
          Small covers in rows instead of tiles.
        </p>
        {save.isError && (
          <p className="text-xs text-destructive">
            Could not save that: {save.error.message}
          </p>
        )}
      </div>
      <div className="shrink-0">
        <Switch
          id="compact-list"
          checked={on}
          disabled={!ready || save.isPending}
          onCheckedChange={(checked) => save.mutate(checked)}
        />
      </div>
    </div>
  )
}
