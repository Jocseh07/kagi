import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Pencil,
  Plus,
  Tags,
  Trash2,
} from 'lucide-react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageContainer } from '@/components/page-container'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorPanel } from '@/components/ui/error-panel'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  createCategory,
  deleteCategory,
  getCategoryCounts,
  listCategories,
  renameCategory,
  reorderCategories,
} from '@/lib/db/categories'
import { useDatabase } from '@/lib/db/provider'
import { dbKeys } from '@/lib/db/query-keys'
import type { Category } from '@/lib/db/schema'
import { notify } from '@/lib/ui/toast'

export const Route = createFileRoute('/library/categories')({
  component: CategoriesPage,
})

function CategoriesPage() {
  const { status, error } = useDatabase()
  const ready = status === 'ready'
  const queryClient = useQueryClient()

  const [draftName, setDraftName] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)

  const categories = useQuery({
    queryKey: dbKeys.categories,
    queryFn: listCategories,
    enabled: ready,
    staleTime: 0,
  })

  const counts = useQuery({
    queryKey: [...dbKeys.categories, 'counts'],
    queryFn: () => getCategoryCounts(),
    enabled: ready,
    staleTime: 0,
  })

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: dbKeys.categories })
    void queryClient.invalidateQueries({ queryKey: dbKeys.library })
  }

  const create = useMutation({
    mutationFn: createCategory,
    onSuccess: (_data, name) => {
      notify.success(`Created “${name.trim()}”`)
      setDraftName('')
      invalidate()
    },
    onError: (error) => notify.error('Could not create that category', error),
  })

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      renameCategory(id, name),
    onSuccess: (_data, { name }) => {
      notify.success(`Renamed to “${name.trim()}”`)
      setEditing(null)
      invalidate()
    },
    onError: (error) => notify.error('Could not rename that category', error),
  })

  const remove = useMutation({
    mutationFn: deleteCategory,
    onSuccess: () => {
      notify.success('Category deleted')
      setConfirmingDelete(null)
      invalidate()
    },
    onError: (error) => notify.error('Could not delete that category', error),
  })

  // Reordering says so on screen the instant it lands, so only its failure —
  // which otherwise looks like a row refusing to move — needs reporting.
  const reorder = useMutation({
    mutationFn: reorderCategories,
    onSuccess: invalidate,
    onError: (error) => notify.error('Could not reorder the categories', error),
  })

  const items = categories.data ?? []

  function move(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= items.length) return
    const ordered = items.map((item) => item.id)
    const [moved] = ordered.splice(index, 1)
    if (!moved) return
    ordered.splice(target, 0, moved)
    reorder.mutate(ordered)
  }

  return (
    <PageContainer>
      <header className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon-sm">
          <Link to="/library" aria-label="Back to library">
            <ArrowLeft />
          </Link>
        </Button>
        <h1 className="text-xl font-semibold tracking-tight">Categories</h1>
      </header>

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (draftName.trim()) create.mutate(draftName)
        }}
      >
        <Input
          value={draftName}
          onChange={(event) => setDraftName(event.target.value)}
          placeholder="New category"
          aria-label="New category name"
          disabled={!ready}
        />
        <Button type="submit" disabled={!ready || !draftName.trim() || create.isPending}>
          <Plus />
          Add
        </Button>
      </form>

      {status === 'error' ? (
        <ErrorPanel
          error={error ?? new Error('The library database is unavailable.')}
        />
      ) : categories.isError ? (
        <ErrorPanel
          error={categories.error}
          onRetry={() => void categories.refetch()}
        />
      ) : categories.isPending ? (
        <CategoriesSkeleton />
      ) : items.length === 0 ? (
        <EmptyCategories />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {items.map((category, index) => (
            <li key={category.id}>
              <CategoryRow
                // Remount on rename so the inline edit draft never goes stale.
                key={category.name}
                category={category}
                count={counts.data?.[category.id] ?? 0}
                first={index === 0}
                last={index === items.length - 1}
                editing={editing === category.id}
                confirmingDelete={confirmingDelete === category.id}
                busy={
                  (rename.isPending && rename.variables?.id === category.id) ||
                  (remove.isPending && remove.variables === category.id) ||
                  reorder.isPending
                }
                onEdit={() => setEditing(category.id)}
                onCancelEdit={() => setEditing(null)}
                onRename={(name) => rename.mutate({ id: category.id, name })}
                onAskDelete={() => setConfirmingDelete(category.id)}
                onCancelDelete={() => setConfirmingDelete(null)}
                onDelete={() => remove.mutate(category.id)}
                onMove={(direction) => move(index, direction)}
              />
            </li>
          ))}
        </ul>
      )}
    </PageContainer>
  )
}

function CategoryRow({
  category,
  count,
  first,
  last,
  editing,
  confirmingDelete,
  busy,
  onEdit,
  onCancelEdit,
  onRename,
  onAskDelete,
  onCancelDelete,
  onDelete,
  onMove,
}: {
  category: Category
  count: number
  first: boolean
  last: boolean
  editing: boolean
  confirmingDelete: boolean
  busy: boolean
  onEdit(): void
  onCancelEdit(): void
  onRename(name: string): void
  onAskDelete(): void
  onCancelDelete(): void
  onDelete(): void
  onMove(direction: -1 | 1): void
}) {
  const [draft, setDraft] = useState(category.name)

  if (editing) {
    return (
      <form
        className="flex items-center gap-2 px-3 py-2.5"
        onSubmit={(event) => {
          event.preventDefault()
          if (draft.trim()) onRename(draft)
        }}
      >
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label={`Rename ${category.name}`}
          autoFocus
        />
        <Button type="submit" size="sm" disabled={busy || !draft.trim()}>
          Save
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setDraft(category.name)
            onCancelEdit()
          }}
        >
          Cancel
        </Button>
      </form>
    )
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{category.name}</p>
        <p className="text-xs text-muted-foreground">
          {count} {count === 1 ? 'series' : 'series'}
        </p>
      </div>

      <Button
        variant="ghost"
        size="icon-sm"
        disabled={first || busy}
        aria-label={`Move ${category.name} up`}
        onClick={() => onMove(-1)}
      >
        <ChevronUp />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={last || busy}
        aria-label={`Move ${category.name} down`}
        onClick={() => onMove(1)}
      >
        <ChevronDown />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Rename ${category.name}`}
        onClick={onEdit}
      >
        <Pencil />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Delete ${category.name}`}
        onClick={onAskDelete}
      >
        <Trash2 />
      </Button>

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={(open) => (open ? onAskDelete() : onCancelDelete())}
        title={`Delete “${category.name}”?`}
        description={`The ${count} series in it stay in your library — only the assignment to this category is removed.`}
        confirmLabel="Delete"
        busyLabel="Deleting…"
        busy={busy}
        onConfirm={onDelete}
      />
    </div>
  )
}

function EmptyCategories() {
  return (
    <EmptyState
      icon={Tags}
      title="No categories yet"
      description="Categories become tabs on the library page. Add one above, then assign series to it from the library."
    />
  )
}

function CategoriesSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} className="h-12 w-full rounded-lg" />
      ))}
    </div>
  )
}
