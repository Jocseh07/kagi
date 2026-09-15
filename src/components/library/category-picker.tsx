import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { FolderPlus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import type { Category } from '@/lib/db/schema'

/**
 * Assigns one category set to the whole selection, replacing whatever each
 * series had. Mihon's tri-state "leave as is" per category is not reproduced;
 * the box is pre-ticked only when every selected series already has it.
 */
export function CategoryPicker({
  open,
  onOpenChange,
  categories,
  /** Category ids shared by every selected series. */
  initial,
  count,
  busy,
  onApply,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  categories: Category[]
  initial: readonly string[]
  count: number
  busy: boolean
  onApply(categoryIds: string[]): void
}) {
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())

  // Re-seeded during render rather than in an effect, so the boxes are already
  // right on the first paint. `initial` arrives from a query, so its identity
  // also changes once while the dialog is open.
  const seed = open ? initial : null
  const [seededFrom, setSeededFrom] = useState<readonly string[] | null>(null)
  if (seededFrom !== seed) {
    setSeededFrom(seed)
    setChecked(new Set(seed ?? []))
  }

  function toggle(id: string) {
    setChecked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set categories</DialogTitle>
          <DialogDescription>
            Applies to {count} selected, replacing whatever categories they are
            in now.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-3 overflow-y-auto">
          {categories.length === 0 ? (
            <div className="space-y-3 py-6 text-center">
              <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                <FolderPlus className="size-5" />
              </div>
              <p className="text-sm text-muted-foreground">
                No categories yet.
              </p>
              <Button asChild variant="outline" size="sm">
                <Link to="/library/categories">Manage categories</Link>
              </Button>
            </div>
          ) : (
            categories.map((category) => (
              <div key={category.id} className="flex items-center gap-2.5">
                <Checkbox
                  id={`category-${category.id}`}
                  checked={checked.has(category.id)}
                  onCheckedChange={() => toggle(category.id)}
                />
                <Label
                  htmlFor={`category-${category.id}`}
                  className="flex-1 font-normal"
                >
                  {category.name}
                </Label>
              </div>
            ))
          )}
        </div>

        {categories.length > 0 && (
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => onApply([...checked])}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
