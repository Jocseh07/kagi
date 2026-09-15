/**
 * Every theme, behind the Theme row on the Appearance tab.
 *
 * The catalog arrives asynchronously and the default is the only entry that
 * exists before it does, so the grid grows by 42 cards a moment after the
 * dialog opens. That is deliberate: the alternative is a quarter of a megabyte
 * of JSON in the initial bundle for a screen most sessions never visit.
 *
 * Applying is synchronous, so the page behind the dialog recolours on the
 * same frame as the click. The dialog stays open for comparing.
 */

import { useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { ThemeImportDialog } from '@/components/theme/theme-import-dialog'
import { ThemePicker } from '@/components/theme/theme-picker'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { tokensToRegistryItem } from '@/lib/theme/css'
import type { ThemePresetsState } from '@/lib/theme/use-theme-presets'
import type { ThemePreset } from '@/lib/theme/tokens'
import { cn } from '@/lib/utils'

type ThemeDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  themes: ThemePresetsState
}

export function ThemeDialog({ open, onOpenChange, themes }: ThemeDialogProps) {
  const [deleting, setDeleting] = useState<ThemePreset | null>(null)
  // Retained so the name stays in the dialog through its exit animation
  // rather than blanking the moment the state clears.
  const lastDeleting = useRef<ThemePreset | null>(null)
  if (deleting) lastDeleting.current = deleting
  const deleteTarget = deleting ?? lastDeleting.current

  function rename(preset: ThemePreset) {
    // A prompt rather than a dialog: renaming is rare, and a third modal on
    // top of this one buys nothing.
    const next = globalThis.prompt('Rename theme', preset.title)
    if (next !== null) themes.renameCustom(preset.id, next)
  }

  function copy(preset: ThemePreset) {
    const json = JSON.stringify(tokensToRegistryItem(preset.id, preset.tokens), null, 2)
    void globalThis.navigator?.clipboard?.writeText(json)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Theme</DialogTitle>
          <DialogDescription>Applies as you pick.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {themes.custom.length > 0 ? (
            <section className="space-y-2">
              <Label>Your themes</Label>
              <ThemePicker
                presets={themes.custom}
                activeId={themes.activeId}
                onSelect={themes.select}
                onCopy={copy}
                onRename={rename}
                onDelete={setDeleting}
              />
            </section>
          ) : null}

          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>Presets</Label>
              <div className="flex items-center gap-2">
                <ThemeImportDialog
                  onSave={(title, tokens) => themes.select(themes.saveCustom(title, tokens))}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void themes.refresh()}
                  disabled={themes.refreshing}
                >
                  <RefreshCw className={cn(themes.refreshing && 'animate-spin')} />
                  {themes.refreshing ? 'Checking…' : 'Check for new'}
                </Button>
              </div>
            </div>

            {themes.refreshError ? (
              <p className="text-xs text-destructive" role="status">
                Could not reach tweakcn. {themes.refreshError}
              </p>
            ) : null}

            <ThemePicker
              presets={themes.builtIn}
              activeId={themes.activeId}
              onSelect={themes.select}
            />

            {themes.loading ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {Array.from({ length: 8 }, (_, index) => (
                  <Skeleton key={index} className="h-16 rounded-lg" />
                ))}
              </div>
            ) : null}
          </section>
        </div>
      </DialogContent>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
        title={deleteTarget ? `Delete “${deleteTarget.title}”?` : 'Delete theme?'}
        description="There is no copy to restore it from. Copy its JSON first if you want it back."
        confirmLabel="Delete"
        onConfirm={() => {
          if (deleting) themes.deleteCustom(deleting.id)
          setDeleting(null)
        }}
      />
    </Dialog>
  )
}
