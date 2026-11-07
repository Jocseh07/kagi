import { useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { FolderPlus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ComboboxList } from '@/components/ui/combobox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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

  const options = useMemo(
    () =>
      categories.map((category) => ({
        value: category.id,
        label: category.name,
      })),
    [categories],
  )
  const selected = useMemo(() => [...checked], [checked])

  return (
    <Dialog open={open} onOpenChange={busy ? () => undefined : onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set categories</DialogTitle>
          <DialogDescription>
            Applies to {count} selected, replacing whatever categories they are
            in now.
          </DialogDescription>
        </DialogHeader>

        {categories.length === 0 ? (
          <div className="space-y-3 py-6 text-center">
            <FolderPlus aria-hidden className="mx-auto size-5 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No categories yet.</p>
            <Button asChild variant="outline" size="sm">
              <Link to="/library/categories">Manage categories</Link>
            </Button>
          </div>
        ) : (
          <ComboboxList
            multiple
            listLabel="Categories"
            options={options}
            value={selected}
            onChange={(next) => setChecked(new Set(next))}
            searchPlaceholder="Search categories"
            emptyMessage="No category by that name."
          />
        )}

        {categories.length > 0 && (
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
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
