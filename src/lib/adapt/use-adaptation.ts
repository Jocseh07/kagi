import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'

import { createFlushSignal } from './flush'
import { panelId, useComposedPages, useDrawnPanels, useWorkingPanels } from './live'
import {
  findAdaptationByNovel,
  getAdaptStoreVersion,
  getAdaptation,
  getBlob,
  listAdaptations,
  listChapters,
  listCharacters,
  listPageKeys,
  listPanelKeys,
  subscribeAdaptStore,
  subscribeBlob,
  supportsAdaptations,
} from './store'
import type { Adaptation, Character, MangaChapter } from './store'

const storeSignal = createFlushSignal()
subscribeAdaptStore(storeSignal.notify)

function useStoreVersion(): number {
  return useSyncExternalStore(storeSignal.subscribe, getAdaptStoreVersion, () => 0)
}

interface AdaptationDetail {
  adaptation: Adaptation
  characters: Character[]
  chapters: MangaChapter[]
}

/** Stable, so the observer's structural sharing keeps every unchanged chapter, character and adaptation object across store versions. */
function shareDetail(detail: AdaptationDetail | null): AdaptationDetail | null {
  return detail
}

export function useAdaptation(adaptationId: string) {
  const version = useStoreVersion()
  return useQuery({
    queryKey: ['adapt', 'detail', adaptationId, version],
    queryFn: async (): Promise<AdaptationDetail | null> => {
      const stored = await getAdaptation(adaptationId)
      if (!stored) return null
      // Rewritten by every saved image and read by nothing on screen; left in, each panel would re-render the whole page.
      const { blobVersions: _versions, bytes: _bytes, ...adaptation } = stored
      const [characters, chapters] = await Promise.all([
        listCharacters(adaptationId),
        listChapters(adaptationId),
      ])
      return { adaptation, characters, chapters }
    },
    select: shareDetail,
    placeholderData: keepPreviousData,
    // Each store write makes a new key; keeping every old snapshot of all chapters is what filled the tab.
    gcTime: 0,
  })
}

export function useAdaptations() {
  const version = useStoreVersion()
  return useQuery({
    queryKey: ['adapt', 'list', version],
    queryFn: async () => {
      const adaptations = await listAdaptations()
      const items = await Promise.all(
        adaptations.map(async (adaptation) => {
          const chapters = await listChapters(adaptation.id)
          const drawn = chapters.filter((chapter) => chapter.drawnAt !== null).length
          return { adaptation, drawn, planned: chapters.length }
        }),
      )
      return items.sort((a, b) => b.adaptation.createdAt - a.adaptation.createdAt)
    },
    placeholderData: keepPreviousData,
    gcTime: 0,
  })
}

export function useAdaptationForNovel(sourceId: string, novelUrl: string) {
  const version = useStoreVersion()
  return useQuery({
    queryKey: ['adapt', 'for-novel', sourceId, novelUrl, version],
    queryFn: async () => (await findAdaptationByNovel(sourceId, novelUrl)) ?? null,
    placeholderData: keepPreviousData,
    gcTime: 0,
  })
}

export function adaptedNovelKey(sourceId: string, novelUrl: string): string {
  return `${sourceId}\n${novelUrl}`
}

const NO_NOVELS: ReadonlySet<string> = new Set()

/** Every adapted novel as an `adaptedNovelKey`, read once for a whole grid. */
export function useAdaptedNovels(): ReadonlySet<string> {
  const version = useStoreVersion()
  const supported = supportsAdaptations()
  const query = useQuery({
    queryKey: ['adapt', 'novels', version],
    queryFn: async () =>
      new Set((await listAdaptations()).map((adaptation) => adaptedNovelKey(adaptation.sourceId, adaptation.novelUrl))),
    enabled: supported,
    placeholderData: keepPreviousData,
    gcTime: 0,
  })
  return query.data ?? NO_NOVELS
}

/** An object URL for a stored sheet or page, reloaded only when that key is written; the old URL is released once its replacement is shown. */
export function useBlobUrl(key: string | null | undefined): string | null {
  const [loaded, setLoaded] = useState<{ key: string; url: string } | null>(null)
  const latest = useRef<string | null>(null)

  useEffect(() => {
    if (!key) return
    let cancelled = false
    const load = () => {
      void getBlob(key).then((blob) => {
        if (cancelled || !blob) return
        const previous = latest.current
        const url = URL.createObjectURL(blob)
        latest.current = url
        setLoaded({ key, url })
        if (previous) setTimeout(() => URL.revokeObjectURL(previous), 1000)
      })
    }
    load()
    const unsubscribe = subscribeBlob(key, load)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [key])

  useEffect(
    () => () => {
      if (latest.current) URL.revokeObjectURL(latest.current)
    },
    [],
  )

  return loaded && loaded.key === key ? loaded.url : null
}

/** A stored blob loaded once, for images that never change while shown. */
export function useStoredImage(key: string | null): string | null {
  const [loaded, setLoaded] = useState<{ key: string; url: string } | null>(null)
  const latest = useRef<string | null>(null)

  useEffect(() => {
    if (!key) return
    let cancelled = false
    void getBlob(key).then((blob) => {
      if (cancelled || !blob) return
      if (latest.current) URL.revokeObjectURL(latest.current)
      const url = URL.createObjectURL(blob)
      latest.current = url
      setLoaded({ key, url })
    })
    return () => {
      cancelled = true
    }
  }, [key])

  useEffect(
    () => () => {
      if (latest.current) URL.revokeObjectURL(latest.current)
    },
    [],
  )

  return loaded && loaded.key === key ? loaded.url : null
}

export type PanelState = 'done' | 'working' | 'waiting'

/** Which panels and pages of a chapter are drawn, from storage plus the live store. */
export function useChapterProgress(adaptationId: string, chapter: MangaChapter) {
  const live = useDrawnPanels(adaptationId, chapter.number)
  const livePages = useComposedPages(adaptationId, chapter.number)
  const working = useWorkingPanels(adaptationId, chapter.number)
  const finished = chapter.status === 'drawn'
  // Read once: live updates come from the in-memory store, so saving a panel never refetches these.
  const panels = useQuery({
    queryKey: ['adapt', 'panels', adaptationId, chapter.number],
    queryFn: () => listPanelKeys(adaptationId, chapter.number),
    staleTime: Infinity,
    enabled: !finished,
  })
  // Pages lettered before panels were kept have no panels stored, so a lettered page counts as fully drawn.
  const pages = useQuery({
    queryKey: ['adapt', 'pages', adaptationId, chapter.number],
    queryFn: () => listPageKeys(adaptationId, chapter.number),
    staleTime: Infinity,
    enabled: !finished,
  })
  const done = new Set([...(panels.data ?? []), ...live])
  const composed = new Set([...(pages.data ?? []), ...livePages])

  const pageDone = (page: number) => finished || composed.has(page)
  const panelState = (page: number, panel: number): PanelState =>
    pageDone(page) || done.has(panelId(page, panel)) ? 'done' : working.has(panelId(page, panel)) ? 'working' : 'waiting'
  const script = chapter.script ?? []
  const pagesDone = script.filter((_, index) => pageDone(index + 1)).length
  const panelsDone = script.reduce(
    (sum, page, index) => sum + page.panels.filter((_, panel) => panelState(index + 1, panel + 1) === 'done').length,
    0,
  )

  return {
    pageDone,
    panelState,
    pagesDone,
    panelsDone,
    isWorking: (page: number) => [...working].some((id) => id.startsWith(`${page}-`)),
  }
}

export type ChapterProgress = ReturnType<typeof useChapterProgress>
