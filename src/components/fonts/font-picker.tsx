import { useState } from 'react'
import { ChevronsUpDown } from 'lucide-react'

import { FontList } from '@/components/fonts/font-list'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { findFont } from '@/lib/fonts/catalog'
import { useFont } from '@/lib/fonts/use-font'

const THEME_DEFAULT_LABEL = 'Theme default'

/**
 * The app's font, as a combobox.
 *
 * Only the trigger and the popover live here; the list itself is shared with
 * the novel reader, which shows the same catalog against a different setting.
 * The popover stays open across selections — see FontList.
 */
export function FontPicker() {
  const [fontId, setFont] = useFont()
  const [open, setOpen] = useState(false)

  const active = findFont(fontId)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Font"
          className="w-64 justify-between"
        >
          <span className="truncate" style={{ fontFamily: active?.stack }}>
            {active?.name ?? THEME_DEFAULT_LABEL}
          </span>
          <ChevronsUpDown aria-hidden className="size-4 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-72 p-1">
        <FontList
          autoFocus
          value={fontId ?? ''}
          onChange={(id) => setFont(id === '' ? null : id)}
          defaultLabel={THEME_DEFAULT_LABEL}
        />
      </PopoverContent>
    </Popover>
  )
}
