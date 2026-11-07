/**
 * Light, dark, or follow the OS.
 *
 * Its own file because both the Appearance tab and the welcome flow offer the
 * same choice, and a second copy would be a second place for the option list
 * to fall out of step with `THEMES`.
 */

import { Monitor, Moon, Sun } from 'lucide-react'

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { THEMES, useTheme, type Theme } from '@/lib/theme/mode'

const MODE_ICONS = { light: Sun, dark: Moon, system: Monitor } as const

export function ModeChooser() {
  const [theme, setTheme] = useTheme()

  return (
    <ToggleGroup
      type="single"
      aria-label="Mode"
      value={theme}
      // An empty value is a press on the chosen item; a mode is always set.
      onValueChange={(value) => {
        if (value) setTheme(value as Theme)
      }}
      className="grid w-full grid-cols-3 @md:w-auto"
    >
      {THEMES.map((option) => {
        const Icon = MODE_ICONS[option.value]
        return (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            className="h-10 md:h-8"
          >
            <Icon />
            {option.label}
          </ToggleGroupItem>
        )
      })}
    </ToggleGroup>
  )
}
