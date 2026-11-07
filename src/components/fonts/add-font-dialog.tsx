import { useEffect, useState } from 'react'

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
import { Spinner } from '@/components/ui/spinner'
import type { FontOption } from '@/lib/fonts/model'
import { FontNotFoundError, findGoogleFont, keepCustomFont } from '@/lib/fonts/custom'
import { ensureFontLoaded } from '@/lib/fonts/load'

const LOOKUP_DELAY_MS = 400
const SAMPLE = 'The quick brown fox jumps over the lazy dog'

type Lookup =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'found'; font: FontOption }
  | { state: 'missing' }
  | { state: 'failed' }

export function AddFontDialog({ onAdd }: { onAdd: (font: FontOption) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!name.trim()) return

    let current = true
    const timer = setTimeout(() => {
      findGoogleFont(name).then(
        (font) => {
          if (!current) return
          ensureFontLoaded(font)
          setLookup({ state: 'found', font })
        },
        (error: unknown) => {
          if (current) setLookup({ state: error instanceof FontNotFoundError ? 'missing' : 'failed' })
        },
      )
    }, LOOKUP_DELAY_MS)

    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [name, attempt])

  function type(next: string) {
    setName(next)
    setLookup({ state: next.trim() ? 'checking' : 'idle' })
  }

  function retry() {
    setLookup({ state: 'checking' })
    setAttempt((n) => n + 1)
  }

  function close() {
    setOpen(false)
    type('')
  }

  function save() {
    if (lookup.state !== 'found') return
    keepCustomFont(lookup.font)
    onAdd(lookup.font)
    close()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Add font
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a font</DialogTitle>
          <DialogDescription>Any family from fonts.google.com. Saved on this device.</DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="font-name">Font name</Label>
            <Input
              id="font-name"
              value={name}
              onChange={(event) => type(event.target.value)}
              placeholder="Lexend"
              autoComplete="off"
              aria-invalid={lookup.state === 'missing'}
            />
          </div>

          <div className="min-h-12 text-sm" role="status">
            {lookup.state === 'checking' ? (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Spinner size="sm" />
                Looking it up
              </span>
            ) : lookup.state === 'found' ? (
              <p className="text-lg" style={{ fontFamily: lookup.font.stack }}>
                {SAMPLE}
              </p>
            ) : lookup.state === 'missing' ? (
              <span className="text-destructive">
                No Google font by that name. Use the name as fonts.google.com shows it.
              </span>
            ) : lookup.state === 'failed' ? (
              <span className="flex items-center gap-2 text-destructive">
                Couldn't reach Google Fonts.
                <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={retry}>
                  Try again
                </Button>
              </span>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={lookup.state !== 'found'}>
              Add font
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
