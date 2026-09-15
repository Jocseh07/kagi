import { Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useDatabase } from '@/lib/db/provider'
import { getFlag, getSetting, setFlag, setSetting } from '@/lib/db/repositories'
import { queueManager } from '@/lib/download/queue-manager'
import {
  COMIC_CONCURRENCY_CHOICES,
  DEFAULT_MANGA_CONCURRENCY,
  DEFAULT_NOVEL_CONCURRENCY,
  DEFAULT_QUEUE_CONCURRENCY,
  MAX_MANGA_CONCURRENCY,
  MIN_MANGA_CONCURRENCY,
  NOVEL_CONCURRENCY_CHOICES,
  SETTING_AUTO_CLEAR_FINISHED,
  SETTING_MANGA_CONCURRENCY,
  SETTING_NOVEL_CONCURRENCY,
  SETTING_QUEUE_CONCURRENCY,
  normaliseConcurrency,
  normaliseMangaConcurrency,
  normaliseNovelConcurrency,
} from '@/lib/download/queue-types'
import { supportsBackgroundFetch } from '@/lib/offline/background-fetch'
import { SETTING_BACKGROUND_DOWNLOADS, supportsOfflineSave } from '@/lib/offline/types'

const CONCURRENCY_QUERY_KEY = ['db', 'setting', SETTING_QUEUE_CONCURRENCY] as const

const NOVEL_CONCURRENCY_QUERY_KEY = [
  'db',
  'setting',
  SETTING_NOVEL_CONCURRENCY,
] as const

const MANGA_CONCURRENCY_QUERY_KEY = [
  'db',
  'setting',
  SETTING_MANGA_CONCURRENCY,
] as const

const BACKGROUND_QUERY_KEY = [
  'db',
  'setting',
  SETTING_BACKGROUND_DOWNLOADS,
] as const

const AUTO_CLEAR_QUERY_KEY = [
  'db',
  'setting',
  SETTING_AUTO_CLEAR_FINISHED,
] as const

const MANGA_CHOICES = Array.from(
  { length: MAX_MANGA_CONCURRENCY - MIN_MANGA_CONCURRENCY + 1 },
  (_, index) => MIN_MANGA_CONCURRENCY + index,
)

export function DownloadSettingsPanel() {
  const { status } = useDatabase()
  const ready = status === 'ready'
  const queryClient = useQueryClient()

  const concurrency = useQuery({
    queryKey: CONCURRENCY_QUERY_KEY,
    queryFn: async () =>
      normaliseConcurrency(await getSetting(SETTING_QUEUE_CONCURRENCY)),
    enabled: ready,
    staleTime: 0,
  })

  const save = useMutation({
    mutationFn: async (value: number) => {
      const limit = normaliseConcurrency(value)
      await setSetting(SETTING_QUEUE_CONCURRENCY, String(limit))
      // The runtime re-reads this when a drained loop starts again; telling it
      // directly means a queue already running widens or narrows now.
      queueManager.setConcurrency(limit)
      return limit
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: CONCURRENCY_QUERY_KEY }),
  })

  const novelConcurrency = useQuery({
    queryKey: NOVEL_CONCURRENCY_QUERY_KEY,
    queryFn: async () =>
      normaliseNovelConcurrency(await getSetting(SETTING_NOVEL_CONCURRENCY)),
    enabled: ready,
    staleTime: 0,
  })

  const saveNovelConcurrency = useMutation({
    mutationFn: async (value: number) => {
      const limit = normaliseNovelConcurrency(value)
      await setSetting(SETTING_NOVEL_CONCURRENCY, String(limit))
      queueManager.setNovelConcurrency(limit)
      return limit
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: NOVEL_CONCURRENCY_QUERY_KEY }),
  })

  const mangaConcurrency = useQuery({
    queryKey: MANGA_CONCURRENCY_QUERY_KEY,
    queryFn: async () =>
      normaliseMangaConcurrency(await getSetting(SETTING_MANGA_CONCURRENCY)),
    enabled: ready,
    staleTime: 0,
  })

  const saveMangaConcurrency = useMutation({
    mutationFn: async (value: number) => {
      const limit = normaliseMangaConcurrency(value)
      await setSetting(SETTING_MANGA_CONCURRENCY, String(limit))
      queueManager.setMangaConcurrency(limit)
      return limit
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: MANGA_CONCURRENCY_QUERY_KEY }),
  })

  const backgroundFetch = useQuery({
    queryKey: BACKGROUND_QUERY_KEY,
    // Default on, unlike the opt-in flags: see SETTING_BACKGROUND_DOWNLOADS.
    queryFn: async () =>
      (await getSetting(SETTING_BACKGROUND_DOWNLOADS)) !== '0',
    enabled: ready && supportsBackgroundFetch(),
    staleTime: 0,
  })

  const saveBackgroundFetch = useMutation({
    mutationFn: async (value: boolean) => {
      await setSetting(SETTING_BACKGROUND_DOWNLOADS, value ? '1' : '0')
      return value
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: BACKGROUND_QUERY_KEY }),
  })

  const autoClear = useQuery({
    queryKey: AUTO_CLEAR_QUERY_KEY,
    queryFn: () => getFlag(SETTING_AUTO_CLEAR_FINISHED),
    enabled: ready,
    staleTime: 0,
  })

  const saveAutoClear = useMutation({
    mutationFn: async (value: boolean) => {
      await setFlag(SETTING_AUTO_CLEAR_FINISHED, value)
      // A queue already draining picks this up now rather than on its next run.
      queueManager.setAutoClearFinished(value)
      return value
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: AUTO_CLEAR_QUERY_KEY }),
  })

  if (!supportsOfflineSave()) {
    return (
      <section className="rounded-lg border border-border bg-card">
        <header className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-medium">Downloads</h2>
        </header>
        <p className="px-4 py-4 text-sm text-muted-foreground">
          This browser has no service worker or Cache API support, so chapters
          cannot be downloaded for offline reading.
        </p>
      </section>
    )
  }

  // The refetch that confirms a write lags the click, so an in-flight change is
  // shown as if it had already landed.
  const current = save.isPending
    ? normaliseConcurrency(save.variables)
    : (concurrency.data ?? DEFAULT_QUEUE_CONCURRENCY)

  const currentNovel = saveNovelConcurrency.isPending
    ? normaliseNovelConcurrency(saveNovelConcurrency.variables)
    : (novelConcurrency.data ?? DEFAULT_NOVEL_CONCURRENCY)

  const currentMangas = saveMangaConcurrency.isPending
    ? normaliseMangaConcurrency(saveMangaConcurrency.variables)
    : (mangaConcurrency.data ?? DEFAULT_MANGA_CONCURRENCY)

  // Same reasoning for the switch: it follows the click, not the refetch.
  const autoClearOn = saveAutoClear.isPending
    ? saveAutoClear.variables
    : (autoClear.data ?? false)

  const backgroundOn = saveBackgroundFetch.isPending
    ? saveBackgroundFetch.variables
    : (backgroundFetch.data ?? true)

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">Downloads</h2>
        <Link
          to="/downloads"
          className="text-xs text-primary underline-offset-4 hover:underline"
        >
          Open the queue
        </Link>
      </header>

      <div className="divide-y divide-border">
        <div className="flex items-center gap-4 px-4 py-3">
          <div className="min-w-0 flex-1 space-y-0.5">
            <Label htmlFor="queue-concurrency" className="font-normal">
              Chapters at a time per series (comics)
            </Label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Shares one site's rate limit across more chapters. 1 finishes
              each chapter soonest.
            </p>
          </div>
          <div className="shrink-0">
            <Select
              value={String(current)}
              disabled={!ready || concurrency.isPending || save.isPending}
              onValueChange={(value) => save.mutate(Number.parseInt(value, 10))}
            >
              <SelectTrigger id="queue-concurrency" className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMIC_CONCURRENCY_CHOICES.map((value) => (
                  <SelectItem key={value} value={String(value)}>
                    {value}
                    {value === DEFAULT_QUEUE_CONCURRENCY ? ' (default)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex items-center gap-4 px-4 py-3">
          <div className="min-w-0 flex-1 space-y-0.5">
            <Label htmlFor="novel-concurrency" className="font-normal">
              Chapters at a time per series (novels)
            </Label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Novel chapters are small, so many can save together.
            </p>
          </div>
          <div className="shrink-0">
            <Select
              value={String(currentNovel)}
              disabled={
                !ready ||
                novelConcurrency.isPending ||
                saveNovelConcurrency.isPending
              }
              onValueChange={(value) =>
                saveNovelConcurrency.mutate(Number.parseInt(value, 10))
              }
            >
              <SelectTrigger id="novel-concurrency" className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NOVEL_CONCURRENCY_CHOICES.map((value) => (
                  <SelectItem key={value} value={String(value)}>
                    {value}
                    {value === DEFAULT_NOVEL_CONCURRENCY ? ' (default)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex items-center gap-4 px-4 py-3">
          <div className="min-w-0 flex-1 space-y-0.5">
            <Label htmlFor="manga-concurrency" className="font-normal">
              Series at a time
            </Label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Higher stops one long backlog holding up the rest.
            </p>
          </div>
          <div className="shrink-0">
            <Select
              value={String(currentMangas)}
              disabled={
                !ready ||
                mangaConcurrency.isPending ||
                saveMangaConcurrency.isPending
              }
              onValueChange={(value) =>
                saveMangaConcurrency.mutate(Number.parseInt(value, 10))
              }
            >
              <SelectTrigger id="manga-concurrency" className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MANGA_CHOICES.map((value) => (
                  <SelectItem key={value} value={String(value)}>
                    {value}
                    {value === DEFAULT_MANGA_CONCURRENCY ? ' (default)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {supportsBackgroundFetch() && (
          <div className="flex items-center gap-4 px-4 py-3">
            <div className="min-w-0 flex-1 space-y-0.5">
              <Label htmlFor="queue-background" className="font-normal">
                Keep downloading in the background
              </Label>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Continues with the tab hidden or the app closed.
              </p>
            </div>
            <div className="shrink-0">
              <Switch
                id="queue-background"
                checked={backgroundOn}
                disabled={
                  !ready ||
                  backgroundFetch.isPending ||
                  saveBackgroundFetch.isPending
                }
                onCheckedChange={(checked) =>
                  saveBackgroundFetch.mutate(checked)
                }
              />
            </div>
          </div>
        )}

        <div className="flex items-center gap-4 px-4 py-3">
          <div className="min-w-0 flex-1 space-y-0.5">
            <Label htmlFor="queue-auto-clear" className="font-normal">
              Remove finished chapters from the list
            </Label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Finished rows leave the queue. The chapter itself is kept.
            </p>
          </div>
          <div className="shrink-0">
            <Switch
              id="queue-auto-clear"
              checked={autoClearOn}
              disabled={!ready || autoClear.isPending || saveAutoClear.isPending}
              onCheckedChange={(checked) => saveAutoClear.mutate(checked)}
            />
          </div>
        </div>
      </div>

      {(save.isError ||
        saveNovelConcurrency.isError ||
        saveMangaConcurrency.isError ||
        saveAutoClear.isError ||
        saveBackgroundFetch.isError) && (
        <p className="px-4 pb-3 text-xs text-destructive">
          Could not save that:{' '}
          {messageOf(
            save.error ??
              saveNovelConcurrency.error ??
              saveMangaConcurrency.error ??
              saveAutoClear.error ??
              saveBackgroundFetch.error,
          )}
        </p>
      )}
    </section>
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
