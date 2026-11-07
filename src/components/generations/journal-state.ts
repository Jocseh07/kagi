import { useEffect, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { QueryClient, QueryKey } from '@tanstack/react-query'

import { cancelFlush, scheduleFlush } from '@/lib/adapt/flush'
import { initializeRecording } from '@/lib/adapt/journal/files'
import { journalStore, listAdaptationRuns, subscribeJournal } from '@/lib/adapt/journal/store'
import { summarize } from '@/lib/adapt/journal/helpers'
import type { GenerationStage, GenerationStatus, GenerationSummary } from '@/lib/adapt/journal/types'

const JOURNAL_KEY = ['generation-journal'] as const
const RUNS_KEY = ['generation-journal', 'runs'] as const
const ADAPTATION_RUNS_KEY = ['generation-journal', 'adaptation-runs'] as const

export const stageLabels: Record<GenerationStage, string> = {
  plan: 'Plan', beats: 'Beats', script: 'Storyboard', sheet: 'Reference sheet',
  panel: 'Panel', check: 'Check', prompt: 'Prompt',
}

export const statusLabels: Record<GenerationStatus, string> = {
  running: 'Running', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted',
}

export function generationTitle(run: GenerationSummary): string {
  return run.target?.title || `${stageLabels[run.stage]} generation`
}

export function targetLabel(run: GenerationSummary): string {
  const target = run.target
  if (!target) return 'No adaptation target'
  return [target.chapter !== undefined ? `Chapter ${target.chapter}` : null,
    target.page !== undefined ? `Page ${target.page}` : null,
    target.panel !== undefined ? `Panel ${target.panel}` : null,
    target.entityKind, target.entityId].filter(Boolean).join(', ') || 'Adaptation'
}

/** Newest first, as `listRuns` returns them; `keep` false drops the run from the list. */
function withRun(runs: readonly GenerationSummary[], run: GenerationSummary, keep: boolean): GenerationSummary[] {
  const rest = runs.filter((item) => item.id !== run.id)
  if (!keep) return rest
  const at = rest.findIndex((item) => item.createdAt < run.createdAt)
  rest.splice(at < 0 ? rest.length : at, 0, run)
  return rest
}

/** Patches a loaded list in place of a refetch; a list still loading is refetched, since its read may predate the write. An unchanged run is skipped and keeps its object, so it costs no render; the run queries turn off structural sharing, which matches by index and would rebuild every run an insert shifts. */
function patchRuns(client: QueryClient, key: QueryKey, run: GenerationSummary, keep: boolean) {
  const state = client.getQueryState<GenerationSummary[]>(key)
  const known = state?.data?.find((item) => item.id === run.id)
  if (!state || (!keep && !known)) return
  if (state.data === undefined || state.fetchStatus === 'fetching') {
    void client.invalidateQueries({ queryKey: key, exact: true })
    return
  }
  if (keep && known && JSON.stringify(known) === JSON.stringify(run)) return
  client.setQueryData<GenerationSummary[]>(key, withRun(state.data, run, keep))
}

/** Applies journal writes to the cached queries they touch, batched to the shared flush tick, so no write rereads every run. */
function syncJournal(client: QueryClient): () => void {
  const runs = new Map<string, GenerationSummary>()
  const events = new Set<string>()
  const artifacts = new Set<string>()
  const artifactIds = new Set<string>()
  let reload = false
  const flush = () => {
    const keys: QueryKey[] = []
    if (reload) keys.push(JOURNAL_KEY)
    else {
      for (const run of runs.values()) {
        patchRuns(client, RUNS_KEY, run, true)
        for (const query of client.getQueryCache().findAll({ queryKey: ADAPTATION_RUNS_KEY })) {
          patchRuns(client, query.queryKey, run, run.target?.adaptationId === query.queryKey[2])
        }
        keys.push(['generation-journal', 'run', run.id])
      }
      for (const id of events) keys.push(['generation-journal', 'events', id])
      for (const id of artifacts) keys.push(['generation-journal', 'artifacts', id])
      for (const id of artifactIds) keys.push(['generation-journal', 'artifact', id])
      keys.push(['generation-journal', 'replacement-impact'])
    }
    reload = false
    runs.clear()
    events.clear()
    artifacts.clear()
    artifactIds.clear()
    for (const queryKey of keys) void client.invalidateQueries({ queryKey })
  }
  const unsubscribe = subscribeJournal((write) => {
    if (!write) reload = true
    else if (write.kind === 'run') runs.set(write.run.id, summarize(write.run))
    else if (write.kind === 'event') events.add(write.event.generationId)
    else {
      artifacts.add(write.artifact.generationId)
      artifactIds.add(write.artifact.id)
    }
    scheduleFlush(flush)
  })
  return () => {
    unsubscribe()
    cancelFlush(flush)
  }
}

const syncs = new Map<QueryClient, { users: number; stop: () => void }>()

function useJournalSync(client: QueryClient) {
  useEffect(() => {
    const sync = syncs.get(client) ?? { users: 0, stop: syncJournal(client) }
    syncs.set(client, sync)
    sync.users++
    return () => {
      if (--sync.users) return
      sync.stop()
      syncs.delete(client)
    }
  }, [client])
}

export function useJournalSession() {
  const client = useQueryClient()
  const ready = useSyncExternalStore(subscribeJournal, () => true, () => false)
  useJournalSync(client)
  const recording = useQuery({
    queryKey: ['generation-recording-initialize'],
    queryFn: async () => { await initializeRecording(); return true },
    enabled: ready,
    retry: false,
    staleTime: Infinity,
  })
  return { ready, recording }
}

/** Summaries only: request, output and validation payloads load per run with `useJournalRun`. */
export function useJournalRuns(enabled = true) {
  return useQuery({ queryKey: RUNS_KEY, queryFn: async () => (await journalStore.listRuns()).map(summarize), enabled, structuralSharing: false })
}

/** One adaptation's run summaries, newest first; journal writes patch it, so it is read in full only once. */
export function useAdaptationRuns(adaptationId: string, enabled = true) {
  return useQuery({
    queryKey: [...ADAPTATION_RUNS_KEY, adaptationId],
    queryFn: async () => (await listAdaptationRuns(adaptationId)).map(summarize),
    enabled,
    structuralSharing: false,
  })
}

/** A full record, dropped from the cache as soon as nothing shows it. */
export function useJournalRun(id: string, enabled = true) {
  return useQuery({
    queryKey: ['generation-journal', 'run', id],
    queryFn: async () => (await journalStore.getRun(id)) ?? null,
    enabled,
    gcTime: 0,
  })
}

export function useJournalEvents(id: string, enabled = true) {
  return useQuery({ queryKey: ['generation-journal', 'events', id], queryFn: () => journalStore.getEvents(id), enabled })
}
