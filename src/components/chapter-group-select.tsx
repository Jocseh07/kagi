import { useMemo } from 'react'
import { BookOpen, Download } from 'lucide-react'

import { Combobox } from '@/components/ui/combobox'
import { UNGROUPED_LABEL } from '@/lib/chapters/filter-state'
import type { ScanlatorOption } from '@/lib/chapters/filter-state'

/**
 * Picks the one scanlation group a series is read from.
 *
 * There is no "all": an aggregator's groups are parallel copies of the same
 * series, and reading across them hands over chapters already read in another
 * translation. The series page derives a group when none has been chosen, so
 * the control is only ever empty for the moment before that lands.
 */
export function ChapterGroupSelect({
  groups,
  value,
  onChange,
}: {
  groups: ScanlatorOption[]
  /** The followed group's name, or null until one is derived. */
  value: string | null
  onChange(next: string): void
}) {
  const options = useMemo(
    () =>
      groups.map((group) => ({
        value: group.name,
        label: group.name || UNGROUPED_LABEL,
        content: <GroupRow group={group} />,
      })),
    [groups],
  )

  // One group is not a choice, and none means the source does not attribute
  // its chapters at all.
  if (groups.length < 2) return null

  return (
    <Combobox
      label="Scanlation group"
      placeholder="Choose group"
      value={value}
      onChange={onChange}
      options={options}
      searchPlaceholder="Search groups"
      emptyMessage="No groups match."
      align="end"
      className="w-36 shrink-0 sm:w-40"
    />
  )
}

function GroupRow({ group }: { group: ScanlatorOption }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="min-w-0 truncate">{group.name || UNGROUPED_LABEL}</span>

      {/* Not a checkmark: the row already carries one on its left edge for the
          current selection, and two ticks meaning different things in one row
          is worse than no signal at all. */}
      {group.readCount > 0 && (
        <BookOpen className="size-4 shrink-0 text-muted-foreground" />
      )}
      {group.downloadedCount > 0 && (
        <Download className="size-4 shrink-0 text-muted-foreground" />
      )}

      <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
        {group.count}
      </span>
    </span>
  )
}
