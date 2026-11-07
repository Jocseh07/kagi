import { useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BookOpen,
  ChevronRight,
  Compass,
  Database,
  Download,
  Library,
  Palette,
  Trash2,
  Upload,
  Sparkles,
  UserRound,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { AccountSettingsPanel } from '@/components/account/account-settings-panel'
import { AdaptSettingsPanel } from '@/components/adapt/adapt-settings-panel'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { DownloadSettingsPanel } from '@/components/download/download-settings-panel'
import { PageContainer } from '@/components/page-container'
import { GetAppSection } from '@/components/pwa/get-app-section'
import { ReaderSettingsPanel } from '@/components/reader/reader-settings-panel'
import { MihonImportPanel } from '@/components/settings/mihon-import-panel'
import { SettingsMobileHub } from '@/components/settings/mobile-hub'
import { SettingRow, SettingsGroup } from '@/components/settings/settings-group'
import { BrowseSettingsPanel } from '@/components/sources/browse-settings-panel'
import { AppearancePanel } from '@/components/theme/appearance-panel'
import { useStorageBreakdown } from '@/components/storage/use-storage-breakdown'
import { useStoragePersistence } from '@/components/storage/use-storage-persistence'
import { UpdateSettingsPanel } from '@/components/updates/update-settings-panel'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useMediaQuery } from '@/lib/display/use-media-query'
import { exportDatabase, importDatabase } from '@/lib/db/client'
import { runMigrations } from '@/lib/db/migrate'
import { useDatabase } from '@/lib/db/provider'
import { dbKeys } from '@/lib/db/query-keys'
import {
  getFlag,
  listSavedChapters,
  setFlag,
} from '@/lib/db/repositories'
import {
  getSavedChapterLimit,
  setSavedChapterLimit,
  unsaveAllChapters,
  unsaveChapter,
} from '@/lib/offline/save-chapter'
import {
  MAX_SAVED_CHAPTER_LIMIT,
  SAVED_CHAPTER_LIMIT_UNLIMITED,
  SETTING_DELETE_AFTER_READ,
  SETTING_SAVED_CHAPTER_LIMIT,
  SUGGESTED_SAVED_CHAPTER_LIMIT,
  chapterBytes,
  supportsOfflineSave,
} from '@/lib/offline/types'
import type { SavedChapterInfo } from '@/lib/offline/types'
import type { StorageBucketId } from '@/lib/storage/breakdown'

import { accountsEnabled } from '@/lib/sync/config'
import { cn } from '@/lib/utils'
import { notify } from '@/lib/ui/toast'
import { describeError } from '@/lib/ui/describe-error'

/**
 * Grouped the way Mihon groups its settings screens: by the part of the app a
 * setting affects, not by the machinery behind it. Which is why library update
 * rules sit under Library rather than in an "Updates" area of their own, and
 * why the bytes on disk are their own tab instead of riding along with the
 * download queue that happens to produce them. Account leads, and only exists
 * on a build with a Clerk key.
 */
type SettingsTab =
  | 'account'
  | 'appearance'
  | 'library'
  | 'browse'
  | 'reader'
  | 'adapt'
  | 'downloads'
  | 'data'

const SETTINGS_TABS: readonly { value: SettingsTab; label: string; icon: LucideIcon }[] = [
  ...(accountsEnabled
    ? [{ value: 'account' as const, label: 'Account', icon: UserRound }]
    : []),
  { value: 'appearance', label: 'Appearance', icon: Palette },
  { value: 'library', label: 'Library', icon: Library },
  { value: 'browse', label: 'Browse', icon: Compass },
  { value: 'reader', label: 'Reader', icon: BookOpen },
  { value: 'adapt', label: 'Adapt', icon: Sparkles },
  { value: 'downloads', label: 'Downloads', icon: Download },
  { value: 'data', label: 'Data', icon: Database },
]

function isSettingsTab(value: unknown): value is SettingsTab {
  return SETTINGS_TABS.some((tab) => tab.value === value)
}

export const Route = createFileRoute('/settings/')({
  component: SettingsIndex,
  pendingComponent: SettingsPending,
  // `?tab=` is the open section, so a reload, Back, or a link lands on it.
  // `?billing=done` is where Polar checkout returns; the Account panel reads
  // it once and clears it.
  validateSearch: (search: Record<string, unknown>) => ({
    tab: isSettingsTab(search.tab) ? search.tab : undefined,
    billing: search.billing === 'done' ? ('done' as const) : undefined,
  }),
})

const PANEL_CLASS = 'mt-0 flex min-w-0 flex-col gap-page'

function SettingsIndex() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  // Checkout comes back to the section that started it.
  const fallback: SettingsTab =
    accountsEnabled && search.billing === 'done' ? 'account' : 'appearance'
  const tab = search.tab ?? fallback
  const wide = useMediaQuery('(min-width: 48rem)')

  const selectTab = (value: string) => {
    if (!isSettingsTab(value)) return
    void navigate({
      search: (prev) => ({ ...prev, tab: value }),
      replace: true,
    })
  }

  return (
    <PageContainer>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-page">
      <header>
        <h1 className="px-1 text-xl font-semibold tracking-tight md:px-0 md:text-2xl">
          Settings
        </h1>
      </header>

      {/* Phone only: the destinations and the toggle the desktop header keeps
          in its own bar have nowhere else to live down here. */}
      <SettingsMobileHub />

      {/* A list down the side from `md`, a scrolling row above that. The
          orientation follows the layout so the arrow keys match what is seen. */}
      <Tabs
        value={tab}
        onValueChange={selectTab}
        orientation={wide ? 'vertical' : 'horizontal'}
        className="gap-4 md:grid md:grid-cols-[11rem_minmax(0,1fr)] md:items-start md:gap-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10"
      >
        <TabsList
          aria-label="Settings sections"
          className="w-full justify-start overflow-x-auto [scrollbar-width:none] group-data-horizontal/tabs:h-11 md:sticky md:top-4"
        >
          {SETTINGS_TABS.map((item) => (
            <TabsTrigger
              key={item.value}
              value={item.value}
              className="h-full flex-none gap-2 px-3 md:h-9"
            >
              <item.icon />
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* Left out entirely on a build with no Clerk key, where the panels'
            hooks have no provider to read. */}
        {accountsEnabled ? (
          <TabsContent value="account" className={PANEL_CLASS}>
            <AccountSettingsPanel />
          </TabsContent>
        ) : null}

        <TabsContent value="appearance" className={PANEL_CLASS}>
          <AppearancePanel />
        </TabsContent>

        <TabsContent value="library" className={PANEL_CLASS}>
          <UpdateSettingsPanel />
        </TabsContent>

        <TabsContent value="browse" className={PANEL_CLASS}>
          <BrowseSettingsPanel />
        </TabsContent>

        <TabsContent value="reader" className={PANEL_CLASS}>
          <ReaderSettingsPanel />
        </TabsContent>

        <TabsContent value="adapt" className={PANEL_CLASS}>
          <AdaptSettingsPanel />
        </TabsContent>

        {/* Policy about fetching and keeping chapters. What those chapters
            cost on disk is summed on the Data tab. */}
        <TabsContent value="downloads" className={PANEL_CLASS}>
          <DownloadSettingsPanel />
          <SavedChaptersPanel />
        </TabsContent>

        <TabsContent value="data" className={PANEL_CLASS}>
          <GetAppSection />
          <StoragePanel onManageSaved={() => selectTab('downloads')} />
        </TabsContent>
      </Tabs>
      </div>
    </PageContainer>
  )
}

/** The route's shape while its chunk loads; the heading is a constant. */
function SettingsPending() {
  return (
    <PageContainer>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-page">
        <h1 className="px-1 text-xl font-semibold tracking-tight md:px-0 md:text-2xl">
          Settings
        </h1>
        <Skeleton className="h-11 w-full rounded-lg" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    </PageContainer>
  )
}

// ------------------------------------------------------------------ storage --

interface ClearAction {
  label: string
  busy: string
  /**
   * Null where the bytes can be earned back — a saved chapter downloads again,
   * a precached asset refetches — so only the irreversible removals interrupt.
   */
  confirm: { title: string; body: string; commit: string } | null
}

const CLEAR_ACTIONS: Record<StorageBucketId, ClearAction> = {
  'saved-chapters': {
    label: 'Remove all',
    busy: 'Removing…',
    confirm: null,
  },
  library: {
    label: 'Erase',
    busy: 'Erasing…',
    confirm: {
      title: 'Erase your library?',
      body:
        'Every favourite, chapter, setting and saved page in this browser goes. ' +
        'Export a backup first. This cannot be undone.',
      commit: 'Erase library',
    },
  },
  'app-shell': {
    label: 'Clear',
    busy: 'Clearing…',
    confirm: null,
  },
  'imported-books': {
    label: 'Remove all',
    busy: 'Removing…',
    confirm: {
      title: 'Remove imported books?',
      body:
        'Every EPUB and text file imported into this browser goes. Library ' +
        'entries for them stay, but cannot be opened until you import the ' +
        'files again.',
      commit: 'Remove books',
    },
  },
  adaptations: {
    label: 'Remove all',
    busy: 'Removing…',
    confirm: {
      title: 'Remove all adaptations?',
      body:
        'Every character sheet and drawn page goes. Library entries stay, ' +
        'but cannot be opened until the novel is adapted again.',
      commit: 'Remove adaptations',
    },
  },
  other: {
    label: 'Reset',
    busy: 'Resetting…',
    confirm: {
      title: 'Reset the rest?',
      body:
        'Forgets your reader preferences, this device’s id and the folder you ' +
        'picked for local files, then reloads. Your library and saved chapters ' +
        'are untouched. The browser’s own overhead stays, so this figure will ' +
        'not fall to zero.',
      commit: 'Reset and reload',
    },
  },
}

function StoragePanel({ onManageSaved }: { onManageSaved: () => void }) {
  const { status, error } = useDatabase()
  const ready = status === 'ready'
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<File | null>(null)
  // Retained so the filename stays in the dialog through its exit animation
  // rather than the whole thing vanishing mid-fade.
  const lastPending = useRef<File | null>(null)
  if (pending) lastPending.current = pending
  const [confirming, setConfirming] = useState<StorageBucketId | null>(null)

  const storage = useStorageBreakdown()

  const exportDb = useMutation({
    mutationFn: async () => {
      const bytes = await exportDatabase()
      downloadBytes(bytes, 'library.db')
    },
    onSuccess: () =>
      notify.success('Backup exported', { description: 'library.db' }),
    onError: (error) => notify.error('Export failed', error),
  })

  const importDb = useMutation({
    mutationFn: async (file: File) => {
      const bytes = new Uint8Array(await file.arrayBuffer())
      await importDatabase(bytes)
      // The imported file may predate the current schema.
      await runMigrations()
    },
    onSuccess: async () => {
      notify.success('Library restored')
      setPending(null)
      await queryClient.invalidateQueries()
    },
    onError: (error) => notify.error('Restore failed', error),
  })

  const busy = storage.clearing !== null

  return (
    <>
      <SettingsGroup title="Storage">
        {storage.loading ? (
          <div className="space-y-3 px-4 py-4">
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-2.5 w-full rounded-full" />
            <p className="text-xs text-muted-foreground">
              {ready ? 'Measuring…' : 'Loading…'}
            </p>
          </div>
        ) : (
          <>
            {/* Usage, and only usage. The reported quota is not a ceiling a
                reader can plan against, so the bar is what the total is made
                of, never how close it is to a limit. */}
            <div className="space-y-3 px-4 pt-4 pb-3">
              {storage.total !== null && (
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-3xl font-semibold tracking-tight tabular-nums md:text-2xl">
                    {formatBytes(storage.total)}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    used in this browser
                  </span>
                </p>
              )}
              <div
                role="img"
                aria-label={storage.buckets
                  .filter((bucket) => bucket.bytes > 0)
                  .map((bucket) => `${bucket.label} ${formatBytes(bucket.bytes)}`)
                  .join(', ')}
                className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-muted"
              >
                {storage.buckets
                  .filter((bucket) => bucket.bytes > 0)
                  .map((bucket) => (
                    <span
                      key={bucket.id}
                      className={`min-w-1 ${BUCKET_COLOR[bucket.id]}`}
                      style={{ flexGrow: bucket.bytes }}
                    />
                  ))}
              </div>
            </div>

            {/* The rows add up to the figure above: whatever the browser
                charges beyond the buckets this app writes lands in the
                remainder, rather than going unaccounted for. */}
            <ul className="divide-y divide-border border-t border-border">
              {storage.buckets.map((bucket) => {
                const action = CLEAR_ACTIONS[bucket.id]
                const needsDatabase =
                  bucket.id === 'saved-chapters' || bucket.id === 'library'
                const nothingToClear = bucket.id !== 'other' && bucket.bytes === 0

                return (
                  <li
                    key={bucket.id}
                    className="flex items-center gap-2 py-2.5 pr-1.5 pl-4 @sm:gap-3 @sm:pr-2"
                  >
                    <span
                      aria-hidden
                      className={`size-2.5 shrink-0 rounded-full ${BUCKET_COLOR[bucket.id]}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{bucket.label}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {bucket.detail}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm tabular-nums">
                      {bucket.exact ? '' : 'about '}
                      {formatBytes(bucket.bytes)}
                    </span>

                    {/* Saved chapters are removed in one place, the Downloads
                        tab, where they can be removed one at a time too. */}
                    {bucket.id === 'saved-chapters' ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-10 shrink-0 text-muted-foreground md:h-8"
                        onClick={onManageSaved}
                      >
                        Manage
                        <ChevronRight />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className={cn(
                          'h-10 shrink-0 md:h-8',
                          action.confirm ? 'text-destructive' : 'text-muted-foreground',
                        )}
                        disabled={busy || nothingToClear || (needsDatabase && !ready)}
                        aria-label={`${action.label}: ${bucket.label}`}
                        onClick={() => {
                          if (action.confirm) setConfirming(bucket.id)
                          else storage.clear(bucket.id)
                        }}
                      >
                        {storage.clearing === bucket.id ? action.busy : action.label}
                      </Button>
                    )}

                    {action.confirm && (
                      <ConfirmDialog
                        open={confirming === bucket.id}
                        onOpenChange={(open) =>
                          setConfirming(open ? bucket.id : null)
                        }
                        title={action.confirm.title}
                        description={action.confirm.body}
                        confirmLabel={action.confirm.commit}
                        busyLabel={action.busy}
                        busy={busy}
                        onConfirm={() => {
                          setConfirming(null)
                          storage.clear(bucket.id)
                        }}
                      />
                    )}
                  </li>
                )
              })}
            </ul>
          </>
        )}

        {storage.error && (
          <p role="alert" className="px-4 py-3 text-xs text-destructive">
            Could not clear. {describeError(storage.error)}
          </p>
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Backup"
        description="Without Sync, a backup is the only way to move your library to another device."
      >
        <SettingRow
          inline
          label="Export"
          hint="Saves library.db with your favourites, history and settings."
          control={
            <Button
              variant="outline"
              className="h-10 w-28 md:h-9"
              disabled={!ready || exportDb.isPending}
              onClick={() => exportDb.mutate()}
            >
              <Download />
              {exportDb.isPending ? 'Exporting…' : 'Export'}
            </Button>
          }
        />

        <SettingRow
          inline
          label="Restore"
          hint="Replaces everything in this browser with a .db file."
          control={
            <Button
              variant="outline"
              className="h-10 w-28 md:h-9"
              disabled={!ready || importDb.isPending}
              onClick={() => fileInput.current?.click()}
            >
              <Upload />
              {importDb.isPending ? 'Restoring…' : 'Restore'}
            </Button>
          }
        />

        <input
          ref={fileInput}
          type="file"
          accept=".db,.sqlite,.sqlite3,application/vnd.sqlite3,application/x-sqlite3"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0] ?? null
            event.target.value = ''
            setPending(file)
          }}
        />

        {/* Its own row under the raw pair: that pair replaces the database
            wholesale, and this one merges into it. */}
        <MihonImportPanel ready={ready} />

        {status === 'error' && (
          <p className="px-4 py-3 text-xs text-muted-foreground">
            {describeError(error)}
          </p>
        )}
      </SettingsGroup>

      {lastPending.current && (
        <ConfirmDialog
          open={pending !== null}
          onOpenChange={(open) => {
            if (!open) setPending(null)
          }}
          title="Replace your library?"
          description={`Restoring ${lastPending.current.name} (${formatBytes(lastPending.current.size)}) overwrites every favourite, chapter and setting stored in this browser. Export a backup first if you are not sure.`}
          confirmLabel="Replace library"
          busyLabel="Restoring…"
          busy={importDb.isPending}
          onConfirm={() => {
            if (pending) importDb.mutate(pending)
          }}
        />
      )}
    </>
  )
}

/** One chart colour per bucket, paired with its label in the rows below. */
const BUCKET_COLOR: Record<StorageBucketId, string> = {
  'saved-chapters': 'bg-chart-1',
  library: 'bg-chart-2',
  'app-shell': 'bg-chart-3',
  'imported-books': 'bg-chart-4',
  adaptations: 'bg-primary',
  other: 'bg-chart-5',
}

function downloadBytes(bytes: Uint8Array, filename: string): void {
  // Copied into an ArrayBuffer-backed view: Blob rejects SharedArrayBuffer views.
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const blob = new Blob([copy], { type: 'application/x-sqlite3' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log(value) / Math.log(1024)),
  )
  const scaled = value / 1024 ** index
  return `${scaled.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

// ---------------------------------------------------------- saved chapters --

const LIMIT_QUERY_KEY = ['db', 'setting', SETTING_SAVED_CHAPTER_LIMIT] as const

const DELETE_AFTER_READ_QUERY_KEY = [
  'db',
  'setting',
  SETTING_DELETE_AFTER_READ,
] as const

interface SavedSeries {
  mangaId: string
  title: string
  entries: SavedChapterInfo[]
  bytes: number
  /** False where any chapter's size is an estimate, so the total is too. */
  exact: boolean
}

function groupBySeries(rows: SavedChapterInfo[]): SavedSeries[] {
  const groups = new Map<string, SavedSeries>()

  for (const entry of rows) {
    let group = groups.get(entry.mangaId)
    if (!group) {
      group = {
        mangaId: entry.mangaId,
        title: entry.mangaTitle,
        entries: [],
        bytes: 0,
        exact: true,
      }
      groups.set(entry.mangaId, group)
    }
    group.entries.push(entry)
    group.bytes += chapterBytes(entry)
    if (entry.measuredBytes === null) group.exact = false
  }

  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title))
}

function SavedChaptersPanel() {
  const { status } = useDatabase()
  const ready = status === 'ready'
  const queryClient = useQueryClient()

  const saved = useQuery({
    queryKey: dbKeys.savedChapters,
    queryFn: listSavedChapters,
    enabled: ready,
    staleTime: 0,
  })

  const limit = useQuery({
    queryKey: LIMIT_QUERY_KEY,
    queryFn: getSavedChapterLimit,
    enabled: ready,
    staleTime: 0,
  })

  const storage = useStoragePersistence()

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: dbKeys.savedChapters })
    void queryClient.invalidateQueries({ queryKey: ['db', 'saved-chapter-ids'] })
    void queryClient.invalidateQueries({ queryKey: ['db', 'chapter-saved'] })
    void queryClient.invalidateQueries({ queryKey: dbKeys.storage })
  }

  const remove = useMutation({
    mutationFn: (chapterId: string) => unsaveChapter(chapterId),
    onSettled: refresh,
  })

  const removeAll = useMutation({
    mutationFn: unsaveAllChapters,
    onSettled: refresh,
  })

  const removeSeries = useMutation({
    mutationFn: async (group: SavedSeries) => {
      for (const entry of group.entries) await unsaveChapter(entry.chapterId)
    },
    onSettled: refresh,
  })

  // The retroactive half of "delete after read", which only ever applies to
  // chapters finished after it was switched on.
  const removeRead = useMutation({
    mutationFn: async (entries: readonly SavedChapterInfo[]) => {
      for (const entry of entries) await unsaveChapter(entry.chapterId)
    },
    onSettled: refresh,
  })

  const saveLimit = useMutation({
    mutationFn: (value: number) => setSavedChapterLimit(value),
    onSettled: () => queryClient.invalidateQueries({ queryKey: LIMIT_QUERY_KEY }),
  })

  const deleteAfterRead = useQuery({
    queryKey: DELETE_AFTER_READ_QUERY_KEY,
    queryFn: () => getFlag(SETTING_DELETE_AFTER_READ),
    enabled: ready,
    staleTime: 0,
  })

  const saveDeleteAfterRead = useMutation({
    mutationFn: (value: boolean) => setFlag(SETTING_DELETE_AFTER_READ, value),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: DELETE_AFTER_READ_QUERY_KEY }),
  })

  const rows = saved.data ?? []
  const total = rows.reduce((sum, entry) => sum + chapterBytes(entry), 0)
  const series = useMemo(() => groupBySeries(saved.data ?? []), [saved.data])
  const readEntries = useMemo(
    () => (saved.data ?? []).filter((entry) => entry.read),
    [saved.data],
  )
  const busy =
    remove.isPending ||
    removeAll.isPending ||
    removeSeries.isPending ||
    removeRead.isPending
  const capped =
    (limit.data ?? SAVED_CHAPTER_LIMIT_UNLIMITED) !== SAVED_CHAPTER_LIMIT_UNLIMITED
  // The refetch confirming the write lags the click, so show the click.
  const deleteAfterReadOn = saveDeleteAfterRead.isPending
    ? saveDeleteAfterRead.variables
    : (deleteAfterRead.data ?? false)

  // Only rows with a real measurement can describe what a page actually costs.
  const measured = rows.filter((entry) => entry.measuredBytes !== null)
  const measuredPages = measured.reduce((sum, entry) => sum + entry.pageCount, 0)
  const bytesPerPage =
    measuredPages > 0
      ? measured.reduce((sum, entry) => sum + (entry.measuredBytes ?? 0), 0) /
        measuredPages
      : null

  // Headroom in whole chapters, sized by what a chapter has actually cost here.
  const free = storage.usage ? storage.usage.quota - storage.usage.usage : 0
  const perChapter =
    bytesPerPage === null ? 0 : bytesPerPage * (measuredPages / measured.length)
  const remaining = perChapter > 0 && free > 0 ? Math.floor(free / perChapter) : null

  if (!supportsOfflineSave()) {
    return (
      <SettingsGroup title="Saved chapters">
        <p className="px-4 py-4 text-sm text-muted-foreground">
          This browser has no service worker or Cache API support, so chapters
          cannot be kept for offline reading.
        </p>
      </SettingsGroup>
    )
  }

  const removeFailed =
    remove.error ?? removeAll.error ?? removeSeries.error ?? removeRead.error
  const settingFailed = saveLimit.error ?? saveDeleteAfterRead.error

  return (
    <div className="flex flex-col gap-2">
    <SettingsGroup title="Saved chapters">
      {/* The number first: everything below is about changing it. */}
      {!ready ? (
        <div className="space-y-2 px-4 py-4">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-3 w-56" />
        </div>
      ) : (
        <div className="space-y-1 px-4 py-4">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-3xl font-semibold tracking-tight tabular-nums md:text-2xl">
              {rows.length}
            </span>
            <span className="text-sm text-muted-foreground">
              {rows.length === 0 ? (
                'chapters saved'
              ) : (
                <>
                  {rows.length === 1 ? 'chapter' : 'chapters'} ·{' '}
                  {measured.length === rows.length ? '' : 'about '}
                  <span className="text-foreground tabular-nums">
                    {formatBytes(total)}
                  </span>
                </>
              )}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            {bytesPerPage === null
              ? 'Sizes appear once you save a chapter.'
              : `About ${formatBytes(bytesPerPage)} a page.`}
            {remaining !== null &&
              ` Room for about ${remaining.toLocaleString()} more chapter${
                remaining === 1 ? '' : 's'
              }.`}
          </p>
        </div>
      )}

      <SettingRow
        id="delete-after-read"
        inline
        label="Delete chapters once read"
        hint={
          deleteAfterReadOn
            ? 'Applies to chapters you finish from now on.'
            : 'Downloads stay until you remove them.'
        }
        control={
          <Switch
            id="delete-after-read"
            checked={deleteAfterReadOn}
            disabled={
              !ready || deleteAfterRead.isPending || saveDeleteAfterRead.isPending
            }
            onCheckedChange={(checked) => saveDeleteAfterRead.mutate(checked)}
          />
        }
      />

      <SettingRow
        id="saved-limit-on"
        inline
        label="Remove old saves automatically"
        hint={
          capped
            ? 'The oldest save goes first.'
            : 'Saves stay until the browser runs out of room.'
        }
        control={
          <Switch
            id="saved-limit-on"
            checked={capped}
            disabled={!ready || saveLimit.isPending}
            onCheckedChange={(checked) =>
              saveLimit.mutate(
                checked
                  ? SUGGESTED_SAVED_CHAPTER_LIMIT
                  : SAVED_CHAPTER_LIMIT_UNLIMITED,
              )
            }
          />
        }
      />

      {capped ? (
        <SettingRow
          id="saved-limit"
          inline
          label="Keep at most"
          control={
            <span className="flex items-center gap-2">
              <LimitInput
                id="saved-limit"
                value={limit.data ?? ''}
                disabled={!ready || saveLimit.isPending}
                onCommit={(value) => saveLimit.mutate(value)}
              />
              <span className="text-sm text-muted-foreground">chapters</span>
            </span>
          }
        />
      ) : null}

      {settingFailed ? (
        <p role="alert" className="px-4 py-3 text-xs text-destructive">
          Could not save that. {describeError(settingFailed)}
        </p>
      ) : null}
    </SettingsGroup>

      {!ready ? null : rows.length === 0 ? (
        <EmptyState
          icon={Download}
          title="No saved chapters"
          description="Tap download on any chapter to keep it for reading offline."
        />
      ) : (
        <div className="@container overflow-hidden rounded-lg border border-border bg-card">
          <Accordion type="multiple" className="divide-y divide-border">
            {series.map((group) => (
              <AccordionItem
                key={group.mangaId}
                value={group.mangaId}
                className="border-b-0 px-4"
              >
                <AccordionTrigger className="min-h-12 items-center gap-3">
                  <span className="min-w-0 flex-1 truncate">{group.title}</span>
                  <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
                    {group.entries.length} chapter
                    {group.entries.length === 1 ? '' : 's'} ·{' '}
                    {group.exact ? '' : 'about '}
                    {formatBytes(group.bytes)}
                  </span>
                </AccordionTrigger>

                <AccordionContent className="space-y-3 @container">
                  <ul className="divide-y divide-border overflow-hidden rounded-md border border-border @2xl:grid @2xl:grid-cols-2 @2xl:divide-y-0">
                    {group.entries.map((entry) => (
                      <li
                        key={entry.chapterId}
                        className="flex items-center gap-3 py-1.5 pr-1.5 pl-3 @2xl:border-b @2xl:border-border @2xl:odd:border-r"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-2 text-sm">
                            <span className="truncate">{entry.chapterName}</span>
                            {entry.read ? (
                              <Badge variant="secondary" className="shrink-0">
                                Read
                              </Badge>
                            ) : null}
                          </p>
                          <p className="truncate text-xs text-muted-foreground tabular-nums">
                            {entry.pageCount} page
                            {entry.pageCount === 1 ? '' : 's'} ·{' '}
                            {entry.measuredBytes === null ? 'about ' : ''}
                            {formatBytes(chapterBytes(entry))}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-10 shrink-0 text-muted-foreground md:size-8"
                          disabled={busy}
                          onClick={() => remove.mutate(entry.chapterId)}
                          aria-label={`Remove ${group.title} ${entry.chapterName}`}
                        >
                          {remove.isPending && remove.variables === entry.chapterId ? (
                            <Spinner />
                          ) : (
                            <Trash2 />
                          )}
                        </Button>
                      </li>
                    ))}
                  </ul>

                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy}
                    onClick={() => removeSeries.mutate(group)}
                    aria-label={`Remove all saved chapters of ${group.title}`}
                  >
                    <Trash2 />
                    {removeSeries.isPending &&
                    removeSeries.variables?.mangaId === group.mangaId
                      ? 'Removing…'
                      : `Remove all ${group.entries.length}`}
                  </Button>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>

          <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
            {readEntries.length > 0 && (
              <Button
                variant="secondary"
                className="h-10 md:h-9"
                disabled={busy}
                onClick={() => removeRead.mutate(readEntries)}
              >
                <Trash2 />
                {removeRead.isPending
                  ? 'Removing…'
                  : `Remove read (${readEntries.length})`}
              </Button>
            )}

            <Button
              variant="destructive"
              className="h-10 md:h-9"
              disabled={busy}
              onClick={() => removeAll.mutate()}
            >
              <Trash2 />
              {removeAll.isPending ? 'Removing…' : `Remove all ${rows.length}`}
            </Button>
          </div>

          {removeFailed ? (
            <p role="alert" className="px-4 pb-3 text-xs text-destructive">
              Could not remove. {describeError(removeFailed)}
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}

/** Commits on blur or Enter, so the limit is not written on every keystroke. */
function LimitInput({
  id,
  value,
  disabled,
  onCommit,
}: {
  id: string
  value: number | ''
  disabled: boolean
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  const committed = useRef(String(value))

  useEffect(() => {
    const next = String(value)
    if (next !== committed.current) {
      committed.current = next
      setDraft(next)
    }
  }, [value])

  const commit = () => {
    const parsed = Number.parseInt(draft, 10)
    if (!Number.isFinite(parsed) || String(parsed) === committed.current) {
      setDraft(committed.current)
      return
    }
    committed.current = String(parsed)
    setDraft(String(parsed))
    onCommit(parsed)
  }

  return (
    <Input
      id={id}
      type="number"
      min={1}
      max={MAX_SAVED_CHAPTER_LIMIT}
      inputMode="numeric"
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
      }}
      className="w-20"
    />
  )
}
