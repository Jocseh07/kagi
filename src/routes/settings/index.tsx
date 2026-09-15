import { useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BookOpen,
  Compass,
  Database,
  Download,
  Library,
  Palette,
  Trash2,
  Upload,
  UserRound,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { AccountSettingsPanel } from '@/components/account/account-settings-panel'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { DownloadSettingsPanel } from '@/components/download/download-settings-panel'
import { PageContainer } from '@/components/page-container'
import { InstallPanel } from '@/components/pwa/install-panel'
import { ReaderSettingsPanel } from '@/components/reader/reader-settings-panel'
import { MihonImportPanel } from '@/components/settings/mihon-import-panel'
import { SettingsMobileHub } from '@/components/settings/mobile-hub'
import { BrowseSettingsPanel } from '@/components/sources/browse-settings-panel'
import { SyncPanel } from '@/components/sync/sync-panel'
import { AppearancePanel } from '@/components/theme/appearance-panel'
import { StoragePersistenceNotice } from '@/components/storage/persistence-notice'
import { useStorageBreakdown } from '@/components/storage/use-storage-breakdown'
import { useStoragePersistence } from '@/components/storage/use-storage-persistence'
import { UpdateSettingsPanel } from '@/components/updates/update-settings-panel'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
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
import { Tabs } from '@heroui/react'

import { accountsEnabled } from '@/lib/sync/config'
import { notify } from '@/lib/ui/toast'

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
  { value: 'downloads', label: 'Downloads', icon: Download },
  { value: 'data', label: 'Data', icon: Database },
]

function isSettingsTab(value: unknown): value is SettingsTab {
  return SETTINGS_TABS.some((tab) => tab.value === value)
}

export const Route = createFileRoute('/settings/')({
  component: SettingsIndex,
  // `?tab=` is the open section, so a reload, Back, or a link lands on it.
  // `?billing=done` is where Polar checkout returns; the Account panel reads
  // it once and clears it.
  validateSearch: (search: Record<string, unknown>) => ({
    tab: isSettingsTab(search.tab) ? search.tab : undefined,
    billing: search.billing === 'done' ? ('done' as const) : undefined,
  }),
})

/** The page rhythm owns the spacing, so the library's panel padding is dropped. */
const PANEL_CLASS = 'mt-0 p-0'

function SettingsIndex() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  // Checkout comes back to the section that started it.
  const fallback: SettingsTab =
    accountsEnabled && search.billing === 'done' ? 'account' : 'appearance'
  const tab = search.tab ?? fallback

  const selectTab = (value: string) => {
    if (!isSettingsTab(value)) return
    void navigate({
      search: (prev) => ({ ...prev, tab: value }),
      replace: true,
    })
  }

  return (
    <PageContainer>
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      </header>

      {/* Phone only: the destinations and the toggle the desktop header keeps
          in its own bar have nowhere else to live down here. */}
      <SettingsMobileHub />

      <Tabs
        selectedKey={tab}
        onSelectionChange={(key) => selectTab(String(key))}
        className="gap-page"
      >
        {/* Content-width rather than stretched across the page: `max-w-full` is
            what forces the overflow that makes HeroUI's own scroller and its
            chevrons engage once the sections stop fitting, which on a phone is
            immediately. */}
        <Tabs.ListContainer className="w-fit max-w-full">
          <Tabs.List aria-label="Settings sections">
            {/* `w-fit shrink-0`: HeroUI sizes a tab `w-full`, which inside the
                strip's max-content list divides the width equally and squeezes
                the longest label below its own text. */}
            {SETTINGS_TABS.map((item) => (
              <Tabs.Tab
                key={item.value}
                id={item.value}
                className="w-fit shrink-0 gap-2"
              >
                <item.icon className="size-4 shrink-0" />
                {item.label}
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>

        {/* Left out entirely on a build with no Clerk key, where the panels'
            hooks have no provider to read. */}
        {accountsEnabled ? (
          <Tabs.Panel id="account" className={PANEL_CLASS + ' space-y-4'}>
            <AccountSettingsPanel />
            <SyncPanel />
          </Tabs.Panel>
        ) : null}

        <Tabs.Panel id="appearance" className={PANEL_CLASS}>
          <AppearancePanel />
        </Tabs.Panel>

        <Tabs.Panel id="library" className={PANEL_CLASS}>
          <UpdateSettingsPanel />
        </Tabs.Panel>

        <Tabs.Panel id="browse" className={PANEL_CLASS}>
          <BrowseSettingsPanel />
        </Tabs.Panel>

        <Tabs.Panel id="reader" className={PANEL_CLASS}>
          <ReaderSettingsPanel />
        </Tabs.Panel>

        {/* Policy about fetching and keeping chapters. What those chapters
            cost on disk is the next tab along. */}
        <Tabs.Panel id="downloads" className={PANEL_CLASS + ' space-y-4'}>
          <DownloadSettingsPanel />
          <SavedChaptersPanel />
        </Tabs.Panel>

        <Tabs.Panel id="data" className={PANEL_CLASS + ' space-y-4'}>
          <StoragePersistenceNotice />
          <InstallPanel />
          <StoragePanel />
        </Tabs.Panel>
      </Tabs>
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
        'Every favourite, chapter, reading position, category and setting kept ' +
        'in this browser goes, and so do the pages of every saved chapter — the ' +
        'record naming them is part of what is erased. Export a backup first; ' +
        'this cannot be undone.',
      commit: 'Erase library',
    },
  },
  'app-shell': {
    label: 'Clear',
    busy: 'Clearing…',
    confirm: null,
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

function StoragePanel() {
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
      notify.success('Backup imported')
      setPending(null)
      await queryClient.invalidateQueries()
    },
    onError: (error) => notify.error('Import failed', error),
  })

  const busy = storage.clearing !== null

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">Storage</h2>
        <span className="text-xs text-muted-foreground">
          Backups are the only way to move your library between devices.
        </span>
      </header>

      <div className="space-y-4 px-4 py-4">
        {/* Usage, and only usage. The reported quota is not a ceiling a reader
            can plan against — it moves with free disk and sits far below it —
            so a bar towards it invited the wrong conclusion. */}
        {storage.total !== null && (
          <div className="space-y-1">
            <p className="text-3xl font-semibold tracking-tight tabular-nums sm:text-2xl">
              {formatBytes(storage.total)}
            </p>
            <p className="truncate text-base text-muted-foreground sm:text-sm">
              Used by this app in this browser
            </p>
          </div>
        )}

        <p className="text-xs leading-relaxed text-muted-foreground">
          The browser may reclaim this if the device runs low on space.
        </p>

        {/* The rows add up to the figure above: whatever the browser charges
            beyond the three buckets this app writes lands in the remainder,
            rather than going unaccounted for. */}
        {storage.loading ? (
          <p className="text-sm text-muted-foreground">Measuring…</p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {storage.buckets.map((bucket) => {
              const action = CLEAR_ACTIONS[bucket.id]
              const needsDatabase =
                bucket.id === 'saved-chapters' || bucket.id === 'library'
              const nothingToClear = bucket.id !== 'other' && bucket.bytes === 0

              return (
                <li key={bucket.id} className="px-3 py-2.5">
                  <div className="flex items-center gap-3">
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
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      disabled={
                        busy || nothingToClear || (needsDatabase && !ready)
                      }
                      aria-label={`${action.label}: ${bucket.label}`}
                      onClick={() => {
                        if (action.confirm) setConfirming(bucket.id)
                        else storage.clear(bucket.id)
                      }}
                    >
                      <Trash2 />
                      {storage.clearing === bucket.id ? action.busy : action.label}
                    </Button>
                  </div>

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
        )}

        {storage.error && (
          <p className="text-xs text-destructive">
            Could not clear: {storage.error.message}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!ready || exportDb.isPending}
            onClick={() => exportDb.mutate()}
          >
            <Download />
            {exportDb.isPending ? 'Exporting…' : 'Export database'}
          </Button>

          <Button
            variant="outline"
            size="sm"
            disabled={!ready || importDb.isPending}
            onClick={() => fileInput.current?.click()}
          >
            <Upload />
            Import database
          </Button>

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
        </div>

        {!ready && (
          <p className="text-xs text-muted-foreground">
            {status === 'loading'
              ? 'Waiting for the library database…'
              : (error?.message ?? 'The library database is unavailable.')}
          </p>
        )}

        {lastPending.current && (
          <ConfirmDialog
            open={pending !== null}
            onOpenChange={(open) => {
              if (!open) setPending(null)
            }}
            title="Replace your library?"
            description={`Importing ${lastPending.current.name} (${formatBytes(lastPending.current.size)}) overwrites every favourite, chapter and setting stored in this browser. Export a backup first if you are not sure.`}
            confirmLabel="Replace library"
            busyLabel="Importing…"
            busy={importDb.isPending}
            onConfirm={() => {
              if (pending) importDb.mutate(pending)
            }}
          />
        )}

      </div>

      {/* Its own block under the raw export/import: that pair replaces the
          database wholesale, and this one merges into it. Sharing a row would
          have implied they are the same kind of action. */}
      <MihonImportPanel ready={ready} />
    </section>
  )
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
      <section className="rounded-lg border border-border bg-card">
        <header className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-medium">Saved chapters</h2>
        </header>
        <p className="px-4 py-4 text-sm text-muted-foreground">
          This browser has no service worker or Cache API support, so chapters
          cannot be kept for offline reading.
        </p>
      </section>
    )
  }

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">Saved chapters</h2>
        <span className="text-xs text-muted-foreground">
          {rows.length} saved · {measured.length === rows.length ? '' : 'about '}
          {formatBytes(total)}
        </span>
      </header>

      <div className="space-y-4 px-4 py-4">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {bytesPerPage === null
            ? 'Sizes appear once you save a chapter.'
            : `About ${formatBytes(bytesPerPage)} per page, measured over ${measuredPages} saved page${
                measuredPages === 1 ? '' : 's'
              }.`}
          {storage.usage && ` ${formatBytes(storage.usage.usage)} used in total.`}
          {remaining !== null && ` About ${remaining} more chapter${
            remaining === 1 ? '' : 's'
          } will fit.`}
        </p>

        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Switch
              id="delete-after-read"
              checked={deleteAfterReadOn}
              disabled={
                !ready ||
                deleteAfterRead.isPending ||
                saveDeleteAfterRead.isPending
              }
              onCheckedChange={(checked) => saveDeleteAfterRead.mutate(checked)}
            />
            <Label htmlFor="delete-after-read" className="font-normal">
              Delete a chapter's download once you have read it
            </Label>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {deleteAfterReadOn
              ? 'Applies to chapters you finish from now on.'
              : 'Downloads stay until you remove them.'}
          </p>

          <div className="flex items-center gap-3">
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
            <Label htmlFor="saved-limit-on" className="font-normal">
              Remove old saves automatically
            </Label>
          </div>

          {capped ? (
            <div className="flex flex-wrap items-center gap-3">
              <Label htmlFor="saved-limit" className="font-normal">
                Keep at most
              </Label>
              <LimitInput
                id="saved-limit"
                value={limit.data ?? ''}
                disabled={!ready || saveLimit.isPending}
                onCommit={(value) => saveLimit.mutate(value)}
              />
              <span className="text-xs text-muted-foreground">
                chapters. The oldest save goes first.
              </span>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Saves stay until the browser runs out of room.
            </p>
          )}
        </div>

        {(saveLimit.isError || saveDeleteAfterRead.isError) && (
          <p className="text-xs text-destructive">
            Could not save that:{' '}
            {(saveLimit.error ?? saveDeleteAfterRead.error)?.message}
          </p>
        )}

        {!ready ? (
          <p className="text-sm text-muted-foreground">
            Waiting for the library database…
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No saved chapters. Tap download on a chapter to queue it.
          </p>
        ) : (
          <>
            <Accordion
              type="multiple"
              className="divide-y divide-border overflow-hidden rounded-lg border border-border"
            >
              {series.map((group) => (
                <AccordionItem
                  key={group.mangaId}
                  value={group.mangaId}
                  className="border-b-0 px-3"
                >
                  <AccordionTrigger className="gap-3">
                    <span className="min-w-0 flex-1 truncate">{group.title}</span>
                    <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
                      {group.entries.length} chapter
                      {group.entries.length === 1 ? '' : 's'} ·{' '}
                      {group.exact ? '' : 'about '}
                      {formatBytes(group.bytes)}
                    </span>
                  </AccordionTrigger>

                  <AccordionContent className="space-y-3">
                    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                      {group.entries.map((entry) => (
                        <li
                          key={entry.chapterId}
                          className="flex items-center gap-3 px-3 py-2.5"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm">{entry.chapterName}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {entry.pageCount} page
                              {entry.pageCount === 1 ? '' : 's'} ·{' '}
                              {entry.measuredBytes === null ? 'about ' : ''}
                              {formatBytes(chapterBytes(entry))}
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => remove.mutate(entry.chapterId)}
                            aria-label={`Remove ${group.title} ${entry.chapterName}`}
                          >
                            <Trash2 />
                            {remove.isPending && remove.variables === entry.chapterId
                              ? 'Removing…'
                              : 'Remove'}
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

            <div className="flex flex-wrap items-center gap-2">
              {readEntries.length > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
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
                size="sm"
                disabled={busy}
                onClick={() => removeAll.mutate()}
              >
                <Trash2 />
                {removeAll.isPending ? 'Removing…' : `Remove all ${rows.length}`}
              </Button>
            </div>
          </>
        )}

        {(remove.isError ||
          removeAll.isError ||
          removeSeries.isError ||
          removeRead.isError) && (
          <p className="text-xs text-destructive">
            Could not remove:{' '}
            {
              (remove.error ??
                removeAll.error ??
                removeSeries.error ??
                removeRead.error)?.message
            }
          </p>
        )}
      </div>
    </section>
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
