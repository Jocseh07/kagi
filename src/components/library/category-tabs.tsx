import type { Category } from '@/lib/db/schema'
import { cn } from '@/lib/utils'

export function CategoryTabs({
  categories,
  counts,
  total,
  selected,
  onSelect,
}: {
  categories: Category[]
  /** Favourites per category id. A missing entry reads as zero. */
  counts: Record<string, number>
  total: number
  selected: string | null
  onSelect(categoryId: string | null): void
}) {
  if (categories.length === 0) return null

  return (
    <div
      role="tablist"
      aria-label="Categories"
      className="bleed-page flex gap-1 overflow-x-auto"
    >
      <CategoryTab
        label="All"
        count={total}
        selected={selected === null}
        onSelect={() => onSelect(null)}
      />
      {categories.map((category) => (
        <CategoryTab
          key={category.id}
          label={category.name}
          count={counts[category.id] ?? 0}
          selected={selected === category.id}
          onSelect={() => onSelect(category.id)}
        />
      ))}
    </div>
  )
}

function CategoryTab({
  label,
  count,
  selected,
  onSelect,
}: {
  label: string
  count: number
  selected: boolean
  onSelect(): void
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
        selected
          ? 'bg-secondary text-foreground'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
      <span className="text-xs text-muted-foreground">{count}</span>
    </button>
  )
}
