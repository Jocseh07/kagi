import { useState } from 'react'
import { BookCheck, FolderPlus, Trash2, X } from 'lucide-react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'

export function SelectionBar({
  count,
  busy,
  onSetCategories,
  onMarkRead,
  onRemove,
  onClear,
}: {
  count: number
  busy: boolean
  onSetCategories(): void
  onMarkRead(): void
  onRemove(): void
  onClear(): void
}) {
  // Held as the count the confirmation was asked for, so changing the
  // selection collapses it back to the normal actions on its own.
  const [confirmingAt, setConfirmingAt] = useState<number | null>(null)
  const confirmingRemove = confirmingAt === count

  return (
    <div className="sticky bottom-0 z-20 -mx-2 border-t border-border bg-card/95 px-2 py-3 backdrop-blur md:-mx-3 md:px-3 lg:-mx-4 lg:px-4">
      <div className="page-width flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Clear selection"
          onClick={onClear}
        >
          <X />
        </Button>
        <span className="mr-auto text-sm font-medium">{count} selected</span>

        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={onSetCategories}
        >
          <FolderPlus />
          Category
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={onMarkRead}>
          <BookCheck />
          Mark read
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => setConfirmingAt(count)}
        >
          <Trash2 />
          Remove
        </Button>
      </div>

      <ConfirmDialog
        open={confirmingRemove}
        onOpenChange={(open) => setConfirmingAt(open ? count : null)}
        title={count === 1 ? 'Remove this series?' : `Remove ${count} series?`}
        description="Reading progress and saved chapters are kept — only the place in your library and any category assignments go."
        confirmLabel="Remove"
        busyLabel="Removing…"
        busy={busy}
        onConfirm={onRemove}
      />
    </div>
  )
}
