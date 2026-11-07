import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ActionError, PendingLabel } from '@/components/generations/recording-controls'
import { targetLabel, useJournalEvents, useJournalRun } from '@/components/generations/journal-state'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { ErrorPanel } from '@/components/ui/error-panel'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { MISSING_ENDPOINT } from '@/lib/adapt/client'
import { replayGeneration } from '@/lib/adapt/journal/replay'
import { applyGeneration, getReplacementImpact } from '@/lib/adapt/journal/replacement'
import { journalStore } from '@/lib/adapt/journal/store'
import type { GenerationRecord, GenerationSummary } from '@/lib/adapt/journal/types'
import { readAdaptSettings } from '@/lib/adapt/settings'

/** Loads the full record of `run` only while the dialog is open. */
export function ApplyConfirmation({ run, onClose }: { run: GenerationSummary | null; onClose: () => void }) {
  const client = useQueryClient()
  const record = useJournalRun(run?.id ?? '', run !== null)
  const full = record.data ?? null
  const impact = useQuery({
    queryKey: ['generation-journal', 'replacement-impact', full?.id, full?.updatedAt],
    queryFn: () => { if (!full) throw new Error('Choose a generation first.'); return getReplacementImpact(full) },
    enabled: full !== null,
    retry: false,
    staleTime: 0,
  })
  const apply = useMutation({
    mutationFn: async () => {
      if (!full) throw new Error('Choose a generation first.')
      await applyGeneration(full, journalStore)
      await client.invalidateQueries()
    },
  })
  const missing = record.isError ? record.error : record.isSuccess && !full ? new Error('This generation is no longer in your journal.') : null
  return <AlertDialog open={run !== null} onOpenChange={(open) => { if (!open && !apply.isPending) { apply.reset(); onClose() } }}>
    <AlertDialogContent className="max-h-dvh overflow-y-auto" onEscapeKeyDown={(event) => { if (apply.isPending) event.preventDefault() }}>
      <AlertDialogHeader><AlertDialogTitle>{apply.isSuccess ? 'Replacement applied' : 'Apply this generation?'}</AlertDialogTitle><AlertDialogDescription>{apply.isSuccess ? 'The saved original remains in your journal.' : 'Review the affected work before replacing the current result.'}</AlertDialogDescription></AlertDialogHeader>
      {!apply.isSuccess && (missing ? <ErrorPanel error={missing} onRetry={() => void record.refetch()} /> : impact.isPending ? <p role="status" className="flex items-center gap-2"><Spinner />Checking current version</p> : impact.isError ? <ErrorPanel error={impact.error} onRetry={() => void impact.refetch()} /> : <div className="flex min-w-0 flex-col gap-2"><p className="break-words font-medium">{impact.data.title}</p>{run && <p className="break-words text-sm">{targetLabel(run)}</p>}<ul className="flex list-disc flex-col gap-2 pl-5 text-sm">{impact.data.details.map((detail, index) => <li key={index} className="break-words">{detail}</li>)}</ul></div>)}
      <ActionError title="Replacement blocked" error={apply.error} />
      <AlertDialogFooter><AlertDialogCancel disabled={apply.isPending}>{apply.isSuccess ? 'Close' : 'Keep current'}</AlertDialogCancel>{!apply.isSuccess && <Button type="button" variant="destructive" disabled={apply.isPending || !impact.isSuccess || full?.status !== 'succeeded' || Boolean(full.appliedAt)} onClick={() => apply.mutate()}><PendingLabel pending={apply.isPending}>Apply replacement</PendingLabel></Button>}</AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
}

export interface ReplayInput {
  run: GenerationSummary
  attempt?: number
  model?: string
  prompt?: string
}

/** Replays a saved request once with the current endpoint and credentials. */
export async function replaySaved({ run, attempt, model, prompt }: ReplayInput, signal?: AbortSignal): Promise<GenerationRecord> {
  const current = await readAdaptSettings()
  signal?.throwIfAborted()
  if (!current.endpoint) throw new Error(MISSING_ENDPOINT)
  return replayGeneration(journalStore, run.id, {
    endpoint: current.endpoint, apiKey: current.apiKey,
    attempt,
    model: model?.trim() || run.model, prompt,
    maxRequests: 1, signal,
  })
}

export function useReplay() {
  const controller = useRef<AbortController | null>(null)
  const replay = useMutation({
    mutationFn: async (input: ReplayInput) => {
      controller.current = new AbortController()
      try { return await replaySaved(input, controller.current.signal) } finally { controller.current = null }
    },
  })
  return { replay, cancel: () => controller.current?.abort() }
}

export function RetryControls({ run, onReplay }: { run: GenerationRecord; onReplay: (run: GenerationRecord) => void }) {
  const events = useJournalEvents(run.id)
  const settings = useQuery({ queryKey: ['generation-retry-settings'], queryFn: readAdaptSettings, staleTime: 0 })
  const [attempt, setAttempt] = useState('original')
  const [model, setModel] = useState(run.model)
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState('compare')
  const [application, setApplication] = useState<GenerationRecord | null>(null)
  const { replay: retry, cancel } = useReplay()
  const submit = () => retry.mutate(
    { run, attempt: attempt === 'original' ? undefined : Number(attempt), model, prompt: prompt.trim() ? prompt : undefined },
    {
      onSuccess: (result) => {
        onReplay(result)
        if (mode === 'replace' && result.status === 'succeeded') setApplication(result)
      },
    },
  )
  const attempts = [...new Set((events.data ?? []).filter((event) => event.kind === 'request' && event.attempt !== undefined).map((event) => event.attempt))]
  return <section aria-labelledby="retry-heading" className="flex min-w-0 flex-col gap-4">
    <h2 id="retry-heading" className="text-lg font-semibold">Retry generation</h2>
    <form className="flex min-w-0 flex-col gap-4" onSubmit={(event) => { event.preventDefault(); if (!retry.isPending) submit() }}>
      <fieldset disabled={retry.isPending} className="min-w-0">
        <FieldGroup>
          <Field><FieldLabel htmlFor="retry-mode">Result</FieldLabel><NativeSelect id="retry-mode" name="retry-mode" value={mode} onChange={(event) => setMode(event.target.value)}><NativeSelectOption value="compare">Compare only</NativeSelectOption><NativeSelectOption value="replace">Review replacement</NativeSelectOption></NativeSelect></Field>
          <Field><FieldLabel htmlFor="retry-attempt">Saved input</FieldLabel><NativeSelect id="retry-attempt" name="retry-attempt" value={attempt} onChange={(event) => setAttempt(event.target.value)}><NativeSelectOption value="original">Original request</NativeSelectOption>{attempts.map((number) => <NativeSelectOption key={number} value={number}>Attempt {number}</NativeSelectOption>)}</NativeSelect>{events.isError && <ErrorPanel error={events.error} onRetry={() => void events.refetch()} />}</Field>
          <Field><FieldLabel htmlFor="retry-model">Model</FieldLabel><Input id="retry-model" name="retry-model" value={model} onChange={(event) => setModel(event.target.value)} /></Field>
          <Field><FieldLabel htmlFor="retry-prompt">Prompt override</FieldLabel><Textarea id="retry-prompt" name="retry-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} /><FieldDescription>Leave empty to reuse the saved prompt.</FieldDescription></Field>
        </FieldGroup>
      </fieldset>
      {settings.isError ? <ErrorPanel error={settings.error} onRetry={() => void settings.refetch()} /> : settings.data && <p className="break-all text-sm text-muted-foreground">{settings.data.endpoint ? `Endpoint: ${settings.data.endpoint}` : MISSING_ENDPOINT}</p>}
      <p className="text-sm text-muted-foreground">Uses current credentials. One provider request may incur charges.</p>
      <Button type="submit" disabled={retry.isPending || settings.isPending || settings.isError || !settings.data?.endpoint || run.status === 'running'}><PendingLabel pending={retry.isPending}>{mode === 'compare' ? 'Run comparison' : 'Retry for replacement'}</PendingLabel></Button>
      {retry.isPending && <div className="flex flex-col gap-2"><p role="status" className="text-sm text-muted-foreground">Waiting for the provider. The retry is saved in your journal.</p><Button type="button" variant="outline" onClick={cancel}>Cancel retry</Button></div>}
      <ActionError title="Retry failed" error={retry.error} />
      {retry.isSuccess && retry.data.status !== 'succeeded' && <Alert variant="destructive"><AlertTitle>Retry did not succeed</AlertTitle><AlertDescription>Inspect the retry evidence before trying again.</AlertDescription></Alert>}
    </form>
    {run.appliedAt ? <p role="status" className="text-sm text-muted-foreground">Applied {new Date(run.appliedAt).toLocaleString()}</p> : run.status === 'succeeded' && run.parentId && run.target && <Button type="button" variant="outline" disabled={retry.isPending} onClick={() => setApplication(run)}>{run.applicationRequested ? 'Review proposed replacement' : 'Review replacement'}</Button>}
    <ApplyConfirmation key={application?.id ?? 'closed'} run={application} onClose={() => setApplication(null)} />
  </section>
}
