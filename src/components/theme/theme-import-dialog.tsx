/**
 * Bringing a theme in from tweakcn.
 *
 * tweakcn hands out two things for the same theme — a registry item and a
 * block of CSS — and which one ends up on the clipboard is an accident of
 * which button was pressed. Both are accepted, told apart by their first
 * character, so there is nothing to choose here beyond a name.
 */

import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { parseTheme, swatchColors } from '@/lib/theme/css'
import { resolveTheme, useTheme } from '@/lib/theme/mode'
import type { ThemeTokens } from '@/lib/theme/tokens'

type ThemeImportDialogProps = {
  onSave: (title: string, tokens: ThemeTokens) => void
}

export function ThemeImportDialog({ onSave }: ThemeImportDialogProps) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [theme] = useTheme()
  const mode = resolveTheme(theme)

  const tokens = useMemo(() => parseTheme(text), [text])
  const tokenCount = tokens
    ? Object.keys(tokens.light).length + Object.keys(tokens.dark).length
    : 0

  function reset() {
    setTitle('')
    setText('')
  }

  function save() {
    if (!tokens) return
    onSave(title, tokens)
    reset()
    setOpen(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Import theme
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import a theme</DialogTitle>
          <DialogDescription>
            Paste what tweakcn gave you — either the registry JSON or the CSS.
            It is saved on this device only.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="theme-name">Name</Label>
            <Input
              id="theme-name"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="My theme"
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="theme-source">Theme</Label>
            <Textarea
              id="theme-source"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={':root {\n  --background: oklch(1 0 0);\n  …\n}'}
              className="max-h-64 min-h-40 font-mono text-xs"
              aria-invalid={text.trim().length > 0 && !tokens}
            />
          </div>

          <p className="text-sm text-muted-foreground" role="status">
            {text.trim().length === 0 ? (
              'Nothing pasted yet.'
            ) : tokens ? (
              <span className="flex items-center gap-2">
                <span className="flex items-center gap-1" aria-hidden>
                  {swatchColors(tokens, mode).map((color, index) => (
                    <span
                      key={index}
                      className="size-4 rounded-full border border-border/60"
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </span>
                {tokenCount} recognised tokens.
              </span>
            ) : (
              'No theme tokens found in that. Check you copied the whole thing.'
            )}
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!tokens}>
            Save theme
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
