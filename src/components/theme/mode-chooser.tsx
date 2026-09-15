/**
 * Light, dark, or follow the OS.
 *
 * Its own file because both the Appearance tab and the welcome flow offer the
 * same choice, and a second copy would be a second place for the option list
 * to fall out of step with `THEMES`.
 */

import { Monitor, Moon, Sun } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { THEMES, useTheme, type Theme } from '@/lib/theme/mode'
import { cn } from '@/lib/utils'

const MODE_ICONS = { light: Sun, dark: Moon, system: Monitor } as const

export function ModeChooser() {
  const [theme, setTheme] = useTheme()

  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Mode">
      {THEMES.map((option) => {
        const Icon = MODE_ICONS[option.value]
        const active = theme === option.value
        return (
          <Button
            key={option.value}
            variant={active ? 'secondary' : 'outline'}
            size="sm"
            role="radio"
            aria-checked={active}
            className={cn(active && 'border-ring')}
            onClick={() => setTheme(option.value as Theme)}
          >
            <Icon />
            {option.label}
          </Button>
        )
      })}
    </div>
  )
}
