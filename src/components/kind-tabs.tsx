import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { ContentKind } from '@/lib/sources/types'

/** The tab that is chosen, where `all` means no narrowing at all. */
export type KindTab = 'all' | ContentKind

const TABS: readonly { value: KindTab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'comic', label: 'Comics' },
  { value: 'novel', label: 'Novels' },
]

/**
 * Reads a `kind` search param. Anything unrecognised, "all" included, comes
 * back undefined — the absence of a narrowing rather than a third kind.
 */
export function kindTabOf(value: unknown): ContentKind | undefined {
  return value === 'comic' || value === 'novel' ? value : undefined
}

/**
 * Comics or novels, above a list that holds both.
 *
 * Shared by Browse and the library so the two read as the same control, even
 * though one counts sources and the other counts favourites. No `TabsContent`:
 * each page draws its own body beneath, because both keep other chrome between
 * the strip and the grid.
 */
export function KindTabs({
  value,
  counts,
  onChange,
  label,
}: {
  value: KindTab
  counts: Record<KindTab, number>
  onChange(next: KindTab): void
  /** Names what is being split, for anyone on a screen reader. */
  label: string
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(next) => onChange(next as KindTab)}
      className="gap-0"
    >
      <TabsList aria-label={label}>
        {TABS.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {/* Label and count share one inline box so the smaller count sits
                on the label's baseline. As two flex items they are centred
                individually, and digits — which have no descender — then read
                as raised. */}
            <span>
              {tab.label}
              <span className="ml-1 text-xs text-muted-foreground tabular-nums">
                {counts[tab.value]}
              </span>
            </span>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
