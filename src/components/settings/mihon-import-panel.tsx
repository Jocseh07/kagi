/**
 * Importing a Mihon backup, from Settings → Data & storage.
 *
 * Two steps on purpose. Reading the file writes nothing, and what it found is
 * shown in full — including everything that will *not* come across — before the
 * import can be started. A backup is someone's whole reading history; being
 * told afterwards which half of it was dropped is not good enough.
 */

import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, FileUp, Library, TriangleAlert } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { ErrorPanel } from '@/components/ui/error-panel'
import { Progress } from '@/components/ui/progress'
import { groupSkipped, planMihonImport } from '@/lib/backup/mihon-plan'
import type { MihonImportPlan } from '@/lib/backup/mihon-plan'
import { runMihonImport } from '@/lib/backup/mihon-import'
import type { ImportProgress, MihonImportResult } from '@/lib/backup/mihon-import'
import { notify } from '@/lib/ui/toast'

export function MihonImportPanel({ ready }: { ready: boolean }) {
  const fileInput = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()

  const [plan, setPlan] = useState<MihonImportPlan | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [result, setResult] = useState<MihonImportResult | null>(null)

  const read = useMutation({
    mutationFn: async (file: File) => {
      const bytes = new Uint8Array(await file.arrayBuffer())
      return planMihonImport(bytes)
    },
    onMutate: () => {
      setPlan(null)
      setResult(null)
    },
    onSuccess: (next) => setPlan(next),
  })

  const run = useMutation({
    mutationFn: (target: MihonImportPlan) =>
      runMihonImport(target, (next) => setProgress(next)),
    onSuccess: async (imported) => {
      setResult(imported)
      setPlan(null)
      setProgress(null)
      setFileName(null)
      notify.success('Backup imported', {
        description: `${imported.seriesAdded} added, ${imported.seriesMerged} merged`,
      })
      await queryClient.invalidateQueries()
    },
    onError: (error) => {
      setProgress(null)
      notify.error('Import failed', error)
    },
  })

  const busy = read.isPending || run.isPending
  const importable = plan?.sources.reduce((n, s) => n + s.series, 0) ?? 0

  return (
    <div className="space-y-3 border-t border-border px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-medium">Import from Mihon</h3>
        <p className="text-xs text-muted-foreground">
          Merges — nothing already here is replaced or un-read.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!ready || busy}
          onClick={() => fileInput.current?.click()}
        >
          <FileUp />
          {read.isPending ? 'Reading…' : 'Choose .tachibk file'}
        </Button>
        {fileName && !read.isPending && (
          <span className="truncate text-xs text-muted-foreground">{fileName}</span>
        )}
      </div>

      <input
        ref={fileInput}
        type="file"
        accept=".tachibk,.proto.gz,application/gzip"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          setFileName(file.name)
          read.mutate(file)
        }}
      />

      {read.error && <ErrorPanel error={read.error} />}

      {plan && (
        <div className="space-y-3">
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {plan.sources.map((source) => (
              <li
                key={source.sourceId}
                className="flex items-center gap-3 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{source.sourceName}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {source.chapters.toLocaleString()} chapters,{' '}
                    {source.readChapters.toLocaleString()} read
                    {source.favorites < source.series &&
                      ` · ${source.series - source.favorites} outside the library, history only`}
                  </p>
                </div>
                <span className="shrink-0 font-mono text-sm tabular-nums">
                  {source.series}
                </span>
              </li>
            ))}
            {plan.sources.length === 0 && (
              <li className="px-3 py-2.5 text-sm text-muted-foreground">
                Nothing in this backup comes from a source this app supports.
              </li>
            )}
          </ul>

          <SkippedList plan={plan} />

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={busy || importable === 0}
              onClick={() => run.mutate(plan)}
            >
              <Library />
              {run.isPending
                ? 'Importing…'
                : importable === 0
                  ? 'Nothing to import'
                  : `Import ${importable} series`}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setPlan(null)
                setFileName(null)
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {progress && (
        <div className="space-y-1.5">
          <Progress
            value={Math.round((progress.done / Math.max(progress.total, 1)) * 100)}
          />
          <p className="truncate text-xs text-muted-foreground">
            {progress.done} of {progress.total} · {progress.title}
          </p>
        </div>
      )}

      {result && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {result.seriesAdded} series added, {result.seriesMerged} already here
          and merged. {result.chaptersAdded.toLocaleString()} chapters recorded,{' '}
          {result.chaptersAdvanced.toLocaleString()} existing chapters moved
          forward, {result.historyEntries.toLocaleString()} history entries
          {result.categoriesCreated > 0
            ? `, ${result.categoriesCreated} categories created.`
            : '.'}
        </p>
      )}
    </div>
  )
}

/**
 * What the import leaves behind, named rather than counted.
 *
 * Collapsed by default — it is reference, not the decision — but the totals
 * stay on the trigger so the size of what is being dropped is visible without
 * opening it.
 */
function SkippedList({ plan }: { plan: MihonImportPlan }) {
  const [open, setOpen] = useState(false)
  const groups = groupSkipped(plan.skipped)
  const unmappedChapters = plan.sources.reduce(
    (n, source) => n + source.skippedChapters,
    0,
  )

  if (groups.length === 0 && unmappedChapters === 0) return null

  const series = plan.skipped.length
  const chapters = plan.skipped.reduce((n, entry) => n + entry.chapters, 0)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-lg border border-border">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-accent hover:text-accent-foreground"
          >
            <TriangleAlert className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">
                Skipping {series} series
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {chapters.toLocaleString()} chapters from sources this app does
                not have
                {unmappedChapters > 0 &&
                  ` · ${unmappedChapters} chapters with unreadable links`}
              </span>
            </span>
            <ChevronDown
              className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
            />
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="space-y-3 border-t border-border px-3 py-3">
            {groups.map((group) => (
              <div key={group.sourceName} className="space-y-1.5">
                <div className="flex items-baseline gap-2">
                  <p className="text-sm font-medium">{group.sourceName}</p>
                  <Badge variant="outline">{group.series.length} series</Badge>
                  <span className="text-xs text-muted-foreground">
                    {group.readChapters.toLocaleString()} read of{' '}
                    {group.chapters.toLocaleString()}
                  </span>
                </div>
                <ul className="space-y-1">
                  {group.series.map((entry) => (
                    <li
                      key={`${group.sourceName}:${entry.title}`}
                      className="flex items-baseline gap-2 text-xs text-muted-foreground"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {entry.title}
                      </span>
                      <span className="shrink-0 font-mono tabular-nums">
                        {entry.chapters}
                      </span>
                      {entry.reason === 'unreadable-url' && (
                        <span className="shrink-0">unreadable link</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
