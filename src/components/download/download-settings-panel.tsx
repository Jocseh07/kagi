import { Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ArrowUpRight } from 'lucide-react'

import { SettingRow, SettingsGroup } from '@/components/settings/settings-group'
import { Combobox } from '@/components/ui/combobox'
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
import { describeError } from '@/lib/ui/describe-error'

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

const COMIC_OPTIONS = COMIC_CONCURRENCY_CHOICES.map((value) => ({
  value: String(value),
  label:
    value === DEFAULT_QUEUE_CONCURRENCY ? `${value} (default)` : String(value),
}))

const NOVEL_OPTIONS = NOVEL_CONCURRENCY_CHOICES.map((value) => ({
  value: String(value),
  label:
    value === DEFAULT_NOVEL_CONCURRENCY ? `${value} (default)` : String(value),
}))

const MANGA_OPTIONS = MANGA_CHOICES.map((value) => ({
  value: String(value),
  label:
    value === DEFAULT_MANGA_CONCURRENCY ? `${value} (default)` : String(value),
}))

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
      <SettingsGroup title="Queue">
        <p className="px-4 py-4 text-sm text-muted-foreground">
          This browser has no service worker or Cache API support, so chapters
          cannot be downloaded for offline reading.
        </p>
      </SettingsGroup>
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

  const failed =
    save.error ??
    saveNovelConcurrency.error ??
    saveMangaConcurrency.error ??
    saveAutoClear.error ??
    saveBackgroundFetch.error

  return (
    <SettingsGroup
      title="Queue"
      aside={
        <Link
          to="/downloads"
          className="-my-2 inline-flex h-10 items-center gap-1 hover:text-foreground md:h-8"
        >
          Open the queue
          <ArrowUpRight className="size-3.5" aria-hidden />
        </Link>
      }
    >
      {/* Comics and novels answer the same question with different ceilings,
          so they share a row. */}
      <SettingRow
        label="Chapters at a time per series"
        hint="More spreads one site's rate limit. 1 finishes each chapter soonest."
        className="@md:flex-col @md:items-stretch @lg:flex-row @lg:items-center"
        control={
          <div className="grid grid-cols-2 gap-2 @lg:w-52">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Comics</span>
              <Combobox
                id="queue-concurrency"
                label="Chapters at a time per series, comics"
                panel="narrow"
                className="w-full"
                options={COMIC_OPTIONS}
                value={String(current)}
                disabled={!ready || concurrency.isPending || save.isPending}
                onChange={(value) => save.mutate(Number.parseInt(value, 10))}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Novels</span>
              <Combobox
                id="novel-concurrency"
                label="Chapters at a time per series, novels"
                panel="narrow"
                className="w-full"
                options={NOVEL_OPTIONS}
                value={String(currentNovel)}
                disabled={
                  !ready ||
                  novelConcurrency.isPending ||
                  saveNovelConcurrency.isPending
                }
                onChange={(value) =>
                  saveNovelConcurrency.mutate(Number.parseInt(value, 10))
                }
              />
            </div>
          </div>
        }
      />

      <SettingRow
        id="manga-concurrency"
        label="Series at a time"
        hint="Higher stops one long backlog holding up the rest."
        className="@md:flex-col @md:items-stretch @lg:flex-row @lg:items-center"
        control={
          <Combobox
            id="manga-concurrency"
            label="Series at a time"
            panel="narrow"
            className="w-full @lg:w-52"
            options={MANGA_OPTIONS}
            value={String(currentMangas)}
            disabled={
              !ready ||
              mangaConcurrency.isPending ||
              saveMangaConcurrency.isPending
            }
            onChange={(value) =>
              saveMangaConcurrency.mutate(Number.parseInt(value, 10))
            }
          />
        }
      />

      {supportsBackgroundFetch() && (
        <SettingRow
          id="queue-background"
          inline
          label="Keep downloading in the background"
          hint="Continues with the tab hidden or the app closed."
          control={
            <Switch
              id="queue-background"
              checked={backgroundOn}
              disabled={
                !ready ||
                backgroundFetch.isPending ||
                saveBackgroundFetch.isPending
              }
              onCheckedChange={(checked) => saveBackgroundFetch.mutate(checked)}
            />
          }
        />
      )}

      <SettingRow
        id="queue-auto-clear"
        inline
        label="Clear finished rows from the queue"
        hint={
          failed ? (
            <span role="alert" className="text-destructive">
              Could not save that. {describeError(failed)}
            </span>
          ) : (
            'The chapter itself is kept.'
          )
        }
        control={
          <Switch
            id="queue-auto-clear"
            checked={autoClearOn}
            disabled={!ready || autoClear.isPending || saveAutoClear.isPending}
            onCheckedChange={(checked) => saveAutoClear.mutate(checked)}
          />
        }
      />
    </SettingsGroup>
  )
}

