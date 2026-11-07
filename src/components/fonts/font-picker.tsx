import { X } from 'lucide-react'

import { AddFontDialog } from '@/components/fonts/add-font-dialog'
import { useFontOptions } from '@/components/fonts/font-options'
import { SettingRow } from '@/components/settings/settings-group'
import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import type { FontOption } from '@/lib/fonts/model'
import { removeCustomFont, restoreCustomFont, useCustomFonts } from '@/lib/fonts/custom'
import { useFont } from '@/lib/fonts/use-font'
import { notify } from '@/lib/ui/toast'

const THEME_DEFAULT_LABEL = 'Theme default'

/**
 * The app's font, the button that adds one from Google Fonts, and a row per
 * added font. One `useFont` serves all three so a removal clears the picker.
 *
 * The panel stays open across picks: what is being judged is the text behind
 * it, and closing after every try would make comparing two faces a matter of
 * memory.
 */
export function FontSettings() {
  const [fontId, setFont] = useFont()
  const options = useFontOptions(THEME_DEFAULT_LABEL)
  const custom = useCustomFonts()

  function remove(font: FontOption, index: number) {
    const wasActive = fontId === font.id
    removeCustomFont(font.id)
    if (wasActive) setFont(null)
    notify.success(`Removed ${font.name}`, {
      id: `font-removed-${font.id}`,
      action: {
        label: 'Undo',
        onClick: () => {
          restoreCustomFont(font, index)
          if (wasActive) setFont(font.id)
        },
      },
    })
  }

  return (
    <>
      <SettingRow
        label="Font"
        hint="Overrides the theme's own font."
        control={
          <div className="flex w-full items-center gap-2 @md:w-auto">
            <Combobox
              label="Font"
              value={fontId ?? ''}
              onChange={(id) => setFont(id === '' ? null : id)}
              options={options}
              searchPlaceholder="Search fonts"
              emptyMessage="No font by that name."
              closeOnSelect={false}
              align="start"
              className="min-w-0 flex-1 @md:w-48 @md:flex-none"
            />
            <AddFontDialog onAdd={(font) => setFont(font.id)} />
          </div>
        }
      />

      {custom.map((font, index) => (
        <SettingRow
          key={font.id}
          inline
          label={<span style={{ fontFamily: font.stack }}>{font.name}</span>}
          control={
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${font.name}`}
              onClick={() => remove(font, index)}
            >
              <X />
            </Button>
          }
        />
      ))}
    </>
  )
}
