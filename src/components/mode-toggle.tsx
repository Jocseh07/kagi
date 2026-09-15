import { Monitor, Moon, Sun } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { THEMES, resolveTheme, useTheme, type Theme } from '@/lib/theme/mode'

const ICONS = { light: Sun, dark: Moon, system: Monitor } as const

export function ModeToggle() {
  const [theme, setTheme] = useTheme()
  // The trigger shows what is on screen, so 'system' reads as sun or moon
  // rather than as a third, unrelated glyph.
  const Icon = ICONS[resolveTheme(theme)]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground"
          aria-label="Theme"
          title="Theme"
        >
          <Icon />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(next) => setTheme(next as Theme)}
        >
          {THEMES.map((option) => {
            const OptionIcon = ICONS[option.value]
            return (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                <OptionIcon />
                {option.label}
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
