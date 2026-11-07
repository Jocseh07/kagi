import { useState } from 'react'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { FileSearch } from 'lucide-react'

import { ArtifactInventory, ArtifactView, EvidenceSkeleton, GenerationOutput, Payload } from '@/components/generations/evidence'
import { generationTitle, stageLabels, statusLabels, targetLabel, useJournalEvents, useJournalRun, useJournalRuns, useJournalSession } from '@/components/generations/journal-state'
import { ActionError, PendingLabel, RecordingControls } from '@/components/generations/recording-controls'
import { RetryControls } from '@/components/generations/retry-controls'
import { PageContainer } from '@/components/page-container'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorPanel } from '@/components/ui/error-panel'
import { Field, FieldLabel } from '@/components/ui/field'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { deleteJournalGeneration } from '@/lib/adapt/journal/files'
import { journalStore } from '@/lib/adapt/journal/store'
import { resolveValidation } from '@/lib/adapt/journal/helpers'
import type { GenerationRecord, JournalEvent } from '@/lib/adapt/journal/types'


export function GenerationPage() {
  const { generationId } = useParams({ from: '/generations/$generationId' })
  const { ready, recording } = useJournalSession()
  const run = useJournalRun(generationId, ready)
  const [deletionFailure, setDeletionFailure] = useState<{ id: string; error: Error } | null>(null)
  return <PageContainer>
    <header className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-col gap-2"><Link to="/generations" className="text-sm text-muted-foreground underline underline-offset-4">Generation journal</Link><h1 className="text-xl font-semibold tracking-tight">Generation details</h1></div><RecordingControls ids={[generationId]} /></header>
    {recording.isError && <ErrorPanel error={recording.error} onRetry={() => void recording.refetch()} />}
    {!run.data && deletionFailure?.id === generationId && <ActionError title="File deletion failed" error={deletionFailure.error} />}
    {run.isPending ? <EvidenceSkeleton /> : run.isError ? <ErrorPanel error={run.error} onRetry={() => void run.refetch()} /> : run.data ? <GenerationInspector key={run.data.id} run={run.data} onDeletionError={(error) => setDeletionFailure({ id: generationId, error })} /> : <EmptyState icon={FileSearch} title="Generation not found" description="Import its journal bundle or return to the journal." action={<Button asChild variant="outline"><Link to="/generations">Open journal</Link></Button>} />}
  </PageContainer>
}

function GenerationInspector({ run, onDeletionError }: { run: GenerationRecord; onDeletionError: (error: Error) => void }) {
  const [comparisonId, setComparisonId] = useState(run.parentId ?? '')
  const related = useJournalRuns()
  const candidates = (related.data ?? []).filter((item) => item.id !== run.id && (item.parentId === run.id || item.id === run.parentId || (run.parentId && item.parentId === run.parentId)))
  return <>
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2"><h2 className="min-w-0 break-words text-lg font-semibold">{generationTitle(run)}</h2><Badge variant={run.status === 'failed' || run.status === 'interrupted' ? 'destructive' : 'secondary'}>{statusLabels[run.status]}</Badge>{run.applicationRequested && !run.appliedAt && <Badge variant="outline">Awaiting approval</Badge>}</div>
      <p className="text-muted-foreground">{stageLabels[run.stage]}: {targetLabel(run)}</p>
      <p className="break-all font-mono text-sm text-muted-foreground">{run.id}</p>
      <div><Button asChild><a href="#retry-heading">Retry generation</a></Button></div>
      {run.error && <Alert variant="destructive"><AlertTitle>Generation failed</AlertTitle><AlertDescription className="whitespace-pre-wrap break-words">{run.error}</AlertDescription></Alert>}
    </section>
    <div className="grid min-w-0 gap-8 lg:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-8 lg:col-span-2">
        <section className="flex min-w-0 flex-col gap-3"><h2 className="text-lg font-semibold">Saved input</h2>{run.request ? <Payload value={JSON.stringify(run.request, null, 2)} /> : <EmptyState icon={FileSearch} title="Request unavailable" description="Inspect the attempt files or import the complete bundle." />}</section>
        <section className="flex min-w-0 flex-col gap-4">
          <h2 className="text-lg font-semibold">Output comparison</h2>
          <Field><FieldLabel htmlFor="comparison-generation">Compare with</FieldLabel><NativeSelect id="comparison-generation" name="comparison-generation" value={comparisonId} onChange={(event) => setComparisonId(event.target.value)}><NativeSelectOption value="">No comparison selected</NativeSelectOption>{comparisonId && !candidates.some((item) => item.id === comparisonId) && <NativeSelectOption value={comparisonId}>{comparisonId}</NativeSelectOption>}{candidates.map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.id === run.parentId ? 'Original' : 'Retry'}: {statusLabels[item.status]}, {new Date(item.createdAt).toLocaleString()}</NativeSelectOption>)}</NativeSelect></Field>
          {related.isError && <ErrorPanel error={related.error} onRetry={() => void related.refetch()} />}
          <div className="grid min-w-0 gap-4 md:grid-cols-2"><div className="flex min-w-0 flex-col gap-3"><h3 className="font-medium">This generation</h3><GenerationOutput run={run} /></div><div className="flex min-w-0 flex-col gap-3"><h3 className="font-medium">{comparisonId === run.parentId ? 'Original generation' : 'Comparison generation'}</h3>{comparisonId ? <ComparedGeneration key={comparisonId} id={comparisonId} /> : <p className="text-muted-foreground">Run a comparison or choose a saved retry.</p>}</div></div>
        </section>
        <section className="flex min-w-0 flex-col gap-3"><h2 className="text-lg font-semibold">Attempts and raw output</h2><AttemptHistory id={run.id} /></section>
        <section className="flex min-w-0 flex-col gap-3"><h2 className="text-lg font-semibold">Saved files</h2><ArtifactInventory id={run.id} /></section>
      </div>
      <div className="flex min-w-0 flex-col gap-8">
        <RetryControls run={run} onReplay={(result) => setComparisonId(result.id)} />
        <section className="flex min-w-0 flex-col gap-3"><h2 className="text-lg font-semibold">Generation context</h2>
          <dl className="grid min-w-0 gap-2 text-sm"><dt className="text-muted-foreground">Model</dt><dd className="break-all">{run.model}</dd><dt className="text-muted-foreground">Recorded endpoint</dt><dd className="break-all">{run.endpoint}</dd><dt className="text-muted-foreground">Created</dt><dd>{new Date(run.createdAt).toLocaleString()}</dd><dt className="text-muted-foreground">Updated</dt><dd>{new Date(run.updatedAt).toLocaleString()}</dd><dt className="text-muted-foreground">Attempts</dt><dd className="tabular-nums">{run.attempts}</dd>{run.finishedAt && <><dt className="text-muted-foreground">Duration</dt><dd className="tabular-nums">{Math.max(0, (run.finishedAt - run.createdAt) / 1000).toFixed(1)} seconds</dd></>}{run.operationId && <><dt className="text-muted-foreground">Operation</dt><dd className="break-all">{run.operationId}</dd></>}{run.parentId && <><dt className="text-muted-foreground">Original</dt><dd><Link to="/generations/$generationId" params={{ generationId: run.parentId }} className="break-all underline underline-offset-4">{run.parentId}</Link></dd></>}</dl>
          {run.target && <Payload value={JSON.stringify(run.target, null, 2)} />}
          <ValidationContext run={run} />
        </section>
        <DeleteGeneration run={run} onError={onDeletionError} />
      </div>
    </div>
  </>
}

/** Shared inputs are read only while the section is open. */
function ValidationContext({ run }: { run: GenerationRecord }) {
  const [open, setOpen] = useState(false)
  const context = useQuery({
    queryKey: ['generation-journal', 'validation', run.id, run.updatedAt],
    queryFn: async () => JSON.stringify((await resolveValidation(journalStore, run)) ?? null, null, 2),
    enabled: open,
    gcTime: 0,
  })
  if (run.validation === undefined && !run.inputs) return null
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}><summary className="cursor-pointer py-2 font-medium">Validation context</summary>{open && (context.isPending ? <EvidenceSkeleton /> : context.isError ? <ErrorPanel error={context.error} onRetry={() => void context.refetch()} /> : <Payload value={context.data} />)}</details>
}

function ComparedGeneration({ id }: { id: string }) {
  const query = useJournalRun(id)
  if (query.isPending) return <EvidenceSkeleton />
  if (query.isError) return <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
  if (!query.data) return <EmptyState icon={FileSearch} title="Comparison missing" description="Import the original or retry bundle to compare its output." />
  return <div className="flex min-w-0 flex-col gap-3"><Link to="/generations/$generationId" params={{ generationId: id }} className="break-all text-sm underline underline-offset-4">Inspect {statusLabels[query.data.status].toLowerCase()} generation</Link><GenerationOutput run={query.data} />{query.data.error && <Alert variant="destructive"><AlertTitle>Comparison failed</AlertTitle><AlertDescription className="break-words">{query.data.error}</AlertDescription></Alert>}</div>
}

function AttemptHistory({ id }: { id: string }) {
  const events = useJournalEvents(id)
  if (events.isPending) return <EvidenceSkeleton />
  if (events.isError) return <ErrorPanel error={events.error} onRetry={() => void events.refetch()} />
  if (!events.data.length) return <p className="text-muted-foreground">No attempt events recorded.</p>
  return <ol className="flex min-w-0 flex-col divide-y">{events.data.toSorted((a, b) => a.sequence - b.sequence).map((event) => <AttemptEvent key={event.id} event={event} />)}</ol>
}

function AttemptEvent({ event }: { event: JournalEvent }) {
  const [open, setOpen] = useState(false)
  return <li className="flex min-w-0 flex-col gap-2 py-3"><div className="flex flex-wrap items-center gap-2"><span className="font-medium">{event.attempt !== undefined ? `Attempt ${event.attempt}: ` : ''}{event.kind}</span>{event.status !== undefined && <Badge variant="outline">HTTP {event.status}</Badge>}<time className="text-sm text-muted-foreground" dateTime={new Date(event.at).toISOString()}>{new Date(event.at).toLocaleString()}</time></div>{event.message && <p className="whitespace-pre-wrap break-words text-sm">{event.message}</p>}{(event.artifactId || event.data !== undefined) && <details onToggle={(event) => setOpen(event.currentTarget.open)}><summary className="cursor-pointer py-2 text-sm font-medium">Inspect saved evidence</summary>{open && <div className="flex min-w-0 flex-col gap-3">{event.data !== undefined && <Payload value={JSON.stringify(event.data, null, 2)} />}{event.artifactId && <ArtifactView id={event.artifactId} />}</div>}</details>}</li>
}

function DeleteGeneration({ run, onError }: { run: GenerationRecord; onError: (error: Error) => void }) {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const deletion = useMutation({
    mutationFn: () => deleteJournalGeneration(run.id),
    onSuccess: () => { void navigate({ to: '/generations' }) },
    onError,
  })
  return <section className="flex flex-col gap-3"><h2 className="text-lg font-semibold">Journal retention</h2><AlertDialog open={open} onOpenChange={(value) => { if (!deletion.isPending) { setOpen(value); deletion.reset() } }}><AlertDialogTrigger asChild><Button type="button" variant="outline" disabled={run.status === 'running'}>Delete journal record</Button></AlertDialogTrigger><AlertDialogContent className="max-h-dvh overflow-y-auto" onEscapeKeyDown={(event) => { if (deletion.isPending) event.preventDefault() }}><AlertDialogHeader><AlertDialogTitle>Delete this journal record?</AlertDialogTitle><AlertDialogDescription>Deletes its requests, responses, and saved files from the journal and connected folder. Adaptation content stays unchanged.</AlertDialogDescription></AlertDialogHeader><p className="break-words font-medium">{generationTitle(run)}</p><p className="break-all font-mono text-xs">{run.id}</p><ActionError title="Deletion failed" error={deletion.error} /><AlertDialogFooter><AlertDialogCancel disabled={deletion.isPending}>Keep record</AlertDialogCancel><Button type="button" variant="destructive" disabled={deletion.isPending} onClick={() => deletion.mutate()}><PendingLabel pending={deletion.isPending}>Delete record</PendingLabel></Button></AlertDialogFooter></AlertDialogContent></AlertDialog></section>
}
