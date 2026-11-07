import { useSyncExternalStore } from 'react'

import { createFlushSignal } from './flush'

export type LiveKind = 'panel' | 'sheet'

interface LiveTarget {
  adaptationId: string
  operationId?: string
  generationId?: string
  kind: LiveKind
  chapter?: number
  page?: number
  panel?: number
  /** Character and look, or prop and kind, for sheets. */
  name?: string
  shot: string
}

export interface LiveJob extends LiveTarget {
  id: string
  /** Adaptation title, so other adaptations can name the slot they hold. */
  title: string
  cast: string[]
  startedAt: number
}

const NO_JOBS: readonly LiveJob[] = []
const NO_PANELS: ReadonlySet<string> = new Set()
const NO_PAGES: ReadonlySet<number> = new Set()

let jobs: readonly LiveJob[] = NO_JOBS
let drawn = new Map<string, ReadonlySet<string>>()
let composed = new Map<string, ReadonlySet<number>>()
/** Panels being drawn, per chapter, so a job starting in one chapter leaves every other chapter's rows alone. */
let working = new Map<string, ReadonlySet<string>>()
let nextId = 0
const { notify, subscribe } = createFlushSignal()

function chapterKey(adaptationId: string, chapter: number): string {
  return `${adaptationId}:${chapter}`
}

export function panelId(page: number, panel: number): string {
  return `${page}-${panel}`
}

/** Call once the image slot is held; the returned function ends the job. */
export function startJob(job: Omit<LiveJob, 'id' | 'startedAt'>): () => void {
  const id = String(nextId++)
  jobs = [...jobs, { ...job, id, startedAt: Date.now() }]
  setWorking(job, true)
  notify()
  return () => {
    jobs = jobs.filter((item) => item.id !== id)
    setWorking(job, false)
    notify()
  }
}

function setWorking(job: LiveTarget, on: boolean): void {
  if (job.kind !== 'panel' || job.chapter === undefined || job.page === undefined || job.panel === undefined) return
  const key = chapterKey(job.adaptationId, job.chapter)
  const next = new Set(working.get(key) ?? NO_PANELS)
  if (on) next.add(panelId(job.page, job.panel))
  else next.delete(panelId(job.page, job.panel))
  working = new Map(working)
  if (next.size) working.set(key, next)
  else working.delete(key)
}

export function markPanelDrawn(adaptationId: string, chapter: number, page: number, panel: number): void {
  const key = chapterKey(adaptationId, chapter)
  const id = panelId(page, panel)
  const current = drawn.get(key) ?? NO_PANELS
  if (current.has(id)) return
  drawn = new Map(drawn).set(key, new Set(current).add(id))
  notify()
}

export function markPageComposed(adaptationId: string, chapter: number, page: number): void {
  const key = chapterKey(adaptationId, chapter)
  const current = composed.get(key) ?? NO_PAGES
  if (current.has(page)) return
  composed = new Map(composed).set(key, new Set(current).add(page))
  notify()
}

export function clearChapterProgress(adaptationId: string, chapter: number): void {
  const key = chapterKey(adaptationId, chapter)
  drawn = new Map(drawn)
  composed = new Map(composed)
  drawn.delete(key)
  composed.delete(key)
  notify()
}

/** Drops one adaptation's live state, or all of it. */
export function clearLive(adaptationId?: string): void {
  if (adaptationId === undefined) {
    jobs = NO_JOBS
    drawn = new Map()
    composed = new Map()
    working = new Map()
  } else {
    jobs = jobs.filter((job) => job.adaptationId !== adaptationId)
    drawn = new Map([...drawn].filter(([key]) => !key.startsWith(`${adaptationId}:`)))
    composed = new Map([...composed].filter(([key]) => !key.startsWith(`${adaptationId}:`)))
    working = new Map([...working].filter(([key]) => !key.startsWith(`${adaptationId}:`)))
  }
  notify()
}

/** Panels of one adaptation being drawn right now; a job that starts and ends within one tick costs no render. */
export function useDrawingCount(adaptationId: string): number {
  return useSyncExternalStore(
    subscribe,
    () => jobs.filter((job) => job.adaptationId === adaptationId && job.kind === 'panel').length,
    () => 0,
  )
}

export function useDrawnPanels(adaptationId: string, chapter: number): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => drawn.get(chapterKey(adaptationId, chapter)) ?? NO_PANELS,
    () => NO_PANELS,
  )
}

export function useComposedPages(adaptationId: string, chapter: number): ReadonlySet<number> {
  return useSyncExternalStore(
    subscribe,
    () => composed.get(chapterKey(adaptationId, chapter)) ?? NO_PAGES,
    () => NO_PAGES,
  )
}

export function useWorkingPanels(adaptationId: string, chapter: number): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => working.get(chapterKey(adaptationId, chapter)) ?? NO_PANELS,
    () => NO_PANELS,
  )
}