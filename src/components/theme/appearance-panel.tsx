/**
 * The Appearance tab: one row per choice, in the same shape as the Reader and
 * Library tabs. The theme grid is large enough to be a dialog of its own.
 */

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Palette } from 'lucide-react'

import { FontSettings } from '@/components/fonts/font-picker'
import { TextSizeChooser } from '@/components/display/text-size-chooser'
import { SettingRow, SettingsGroup } from '@/components/settings/settings-group'
import { ModeChooser } from '@/components/theme/mode-chooser'
import { ThemeDialog } from '@/components/theme/theme-dialog'
import { Button } from '@/components/ui/button'
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
import { describeError } from '@/lib/ui/describe-error'

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
    <>
      <SettingsGroup title="Look" aside="Kept on this device">
        <SettingRow
          label="Theme"
          hint="Colours for light and dark."
          control={
            <Button
              variant="outline"
              onClick={() => setChoosing(true)}
              aria-haspopup="dialog"
              className="h-10 w-full justify-start md:h-9 @md:w-48"
            >
              {swatches.length > 0 ? (
                <span className="flex -space-x-1" aria-hidden>
                  {swatches.map((color, index) => (
                    <span
                      key={index}
                      className="size-3.5 rounded-full border border-border"
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </span>
              ) : (
                <Palette />
              )}
              <span className="min-w-0 flex-1 truncate text-left">
                {active?.title ?? 'Choose'}
              </span>
              <ChevronRight className="text-muted-foreground" />
            </Button>
          }
        />

        <SettingRow label="Mode" control={<ModeChooser />} />

        <SettingRow
          label="Text size"
          hint="Scales the whole app, spacing included."
          control={<TextSizeChooser />}
        />

        <FontSettings />
      </SettingsGroup>

      <SettingsGroup title="Lists">
        <CompactListSetting />
      </SettingsGroup>

      <ThemeDialog open={choosing} onOpenChange={setChoosing} themes={themes} />
    </>
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
    <SettingRow
      id="compact-list"
      inline
      label="Compact list view"
      hint={
        save.isError ? (
          <span className="text-destructive">
            Could not save that. {describeError(save.error)}
          </span>
        ) : (
          'Small covers in rows instead of tiles.'
        )
      }
      control={
        <Switch
          id="compact-list"
          checked={on}
          disabled={!ready || save.isPending}
          onCheckedChange={(checked) => save.mutate(checked)}
        />
      }
    />
  )
}
