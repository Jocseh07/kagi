import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { FileSearch } from 'lucide-react'

import { EvidenceSkeleton } from '@/components/generations/evidence'
import { JournalFilters, filterRuns, formatDuration, journalMetrics, useNow } from '@/components/generations/journal-filters'
import type { JournalFilter } from '@/components/generations/journal-filters'
import { generationTitle, stageLabels, statusLabels, targetLabel, useJournalRuns, useJournalSession } from '@/components/generations/journal-state'
import { RecordingControls } from '@/components/generations/recording-controls'
import { PageContainer } from '@/components/page-container'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorPanel } from '@/components/ui/error-panel'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import type { GenerationStatus } from '@/lib/adapt/journal/types'


const statusOrder: Record<GenerationStatus, number> = { failed: 0, interrupted: 1, running: 2, cancelled: 3, succeeded: 4 }
const pageSize = 20

export function GenerationsPage() {
  const { ready, recording } = useJournalSession()
  const runs = useJournalRuns(ready)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<JournalFilter>({ range: 'all', status: 'all', stage: 'all' })
  const [page, setPage] = useState(1)
  const now = useNow(60_000)
  const term = search.trim().toLowerCase()
  const filtered = filterRuns(runs.data ?? [], filter, now).filter((run) =>
    !term || [run.id, generationTitle(run), run.model, stageLabels[run.stage], targetLabel(run)].some((value) => value.toLowerCase().includes(term)),
  ).sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || b.createdAt - a.createdAt || a.id.localeCompare(b.id))
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(page, pages)
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const metrics = journalMetrics(filtered)
  const clear = () => { setSearch(''); setFilter({ range: 'all', status: 'all', stage: 'all' }); setPage(1) }
  const narrowed = Boolean(search || filter.range !== 'all' || filter.status !== 'all' || filter.stage !== 'all')
  return <PageContainer>
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex flex-col gap-2"><h1 className="text-xl font-semibold tracking-tight">Generation journal</h1><p className="text-muted-foreground">Inspect saved requests, compare retries, and approve replacements.</p></div>
      <RecordingControls ids={runs.data ? filtered.map((run) => run.id) : []} />
    </header>
    {recording.isError && <ErrorPanel error={recording.error} onRetry={() => void recording.refetch()} />}
    <div className="grid min-w-0 gap-4 md:grid-cols-2">
      <Field><FieldLabel htmlFor="generation-search">Search generations</FieldLabel><Input id="generation-search" name="generation-search" type="search" value={search} placeholder="Title, model, or ID" onChange={(event) => { setSearch(event.target.value); setPage(1) }} /></Field>
      <JournalFilters id="generation" filter={filter} onChange={(patch) => { setFilter((current) => ({ ...current, ...patch })); setPage(1) }} />
    </div>
    {runs.isPending ? <EvidenceSkeleton /> : runs.isError ? <ErrorPanel error={runs.error} onRetry={() => void runs.refetch()} /> : <>
      <div className="@container"><dl className="grid grid-cols-2 gap-4 @xl:grid-cols-5">
        {[
          ['Recorded', metrics.total],
          ['Needs a retry', metrics.retry],
          ['Running', metrics.running],
          ['Succeeded', metrics.done],
          ['Average time', metrics.averageMs === null ? 'None' : formatDuration(metrics.averageMs)],
        ].map(([label, count]) => <div key={label} className="min-w-0"><dt className="truncate text-sm text-muted-foreground">{label}</dt><dd className="text-2xl font-semibold tabular-nums">{count}</dd></div>)}
      </dl></div>
      {filtered.length === 0 ? <EmptyState icon={FileSearch} title={narrowed ? 'No matching generations' : 'No generations recorded'} description={narrowed ? 'Clear your filters to see all saved generations.' : 'Generate an adaptation or import a journal bundle.'} action={narrowed ? <Button type="button" variant="outline" onClick={clear}>Clear filters</Button> : <Button asChild><Link to="/adapt">Open adaptations</Link></Button>} /> : <>
        <ul className="flex min-w-0 flex-col divide-y rounded-lg border">
          {visible.map((run) => <li key={run.id}><Link to="/generations/$generationId" params={{ generationId: run.id }} className="flex min-w-0 flex-col gap-3 rounded-lg p-4 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col gap-1"><p className="break-words font-medium">{generationTitle(run)}</p><p className="break-words text-sm text-muted-foreground">{stageLabels[run.stage]}: {targetLabel(run)}</p><p className="break-all font-mono text-xs text-muted-foreground">{run.id}</p></div>
            <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end"><Badge variant={run.status === 'failed' || run.status === 'interrupted' ? 'destructive' : 'secondary'}>{statusLabels[run.status]}</Badge>{run.applicationRequested && !run.appliedAt && <Badge variant="outline">Awaiting approval</Badge>}{run.appliedAt && <Badge variant="outline">Applied</Badge>}<span className="break-all text-sm text-muted-foreground">{run.model}</span><time className="text-sm text-muted-foreground" dateTime={new Date(run.createdAt).toISOString()}>{new Date(run.createdAt).toLocaleString()}</time></div>
          </Link></li>)}
        </ul>
        <nav aria-label="Generation pages" className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground" aria-live="polite">{(currentPage - 1) * pageSize + 1}-{Math.min(currentPage * pageSize, filtered.length)} of {filtered.length} generations</p><div className="flex items-center gap-2"><Button type="button" variant="outline" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous page</Button><Button type="button" variant="outline" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>Next page</Button></div></nav>
      </>}
    </>}
  </PageContainer>
}
