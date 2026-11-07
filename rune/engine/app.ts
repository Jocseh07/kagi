import { QueryClient } from '@tanstack/react-query'
import { listSources, getSource } from '@/lib/sources/registry'
import { kindOf } from '@/lib/sources/types'
import { applyStoredPreferences } from '@/lib/sources/preferences'
import { isIncognito } from '@/lib/incognito/store'
import { subscribeChanges } from '@/lib/db/change-signal'
import { subscribeAdaptStore, listAdaptations, updateAdaptation } from '@/lib/adapt/store'
import { onJournalWrite } from '@/lib/adapt/journal/store'
import { startAdaptationRunner, drainAdaptationRunner, subscribeAdaptActivity } from '@/lib/adapt/pipeline'
import { queueManager } from '@/lib/download/queue-manager'
import { updateManager, loadUpdatePrefs, getLastRunAt, markUpdatesSeen } from '@/lib/updates/update-manager'
import type { Action, Dialog, Emit, ImageRef, Params, Result, Screen, Section } from './protocol'
import { params, string, number } from './protocol'
import { action, field, navigate, section, tabs } from './screens/helpers'
import { homeTabs, homeSections, librarySections, categorySections, historySections, updateSections } from './screens/library'
import { browseSections, sourceFilterSection, sourceResults, globalSourceResults, sourceBadge } from './screens/sources'
import { seriesSections, relatedSection, downloadsSection, readerControls } from './screens/series'
import { adaptationList, adaptationSections, adaptationTabs, journalSections, generationSections } from './screens/adaptation'
import { settingsSections } from './screens/settings'
import { themeTokens, settingsTabs } from './services/settings'
import { installedFontFiles, bundledFontFiles } from './services/fonts'
import { mangaOf, recordProgress } from './services/library'
import { readerContent } from './services/reader'
import { performAction } from './services/actions'
import type { MutationContext } from './services/context'
import { cacheSourceImage } from './adapters/image-runtime'
import { initializeRecording } from './adapters/journal-files'
import { waitForDatabaseIdle } from './adapters/database'

const ROUTES: Readonly<Record<string, true>> = { home: true, library: true, categories: true, browse: true, source: true, series: true, reader: true, updates: true, history: true, downloads: true, adaptations: true, adaptation: true, journal: true, generation: true, settings: true, migrate: true }

type Loader = (signal: AbortSignal) => Promise<Section | Section[] | void>

export class NativeApplication {
  private serial = 0
  private routeParams: Params = {}
  private controller = new AbortController()
  private screen: Screen = { route: 'home', routeKey: 'startup', title: 'Kagi', sections: [] }
  private readonly queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } })
  private readonly unsubscribe: (() => void)[] = []
  private undoAction: { label: string; restore: () => Promise<void> } | undefined
  private liveTimer: NodeJS.Timeout | undefined
  private updateTimer: NodeJS.Timeout | undefined
  private liveBusy = false
  private liveAgain = false
  private closed = false
  private started = false
  private maintaining = false
  private readonly loads = new Set<Promise<void>>()
  private liveWork: Promise<void> | undefined
  private lastUpdateAttempt = 0

  constructor(private ready: boolean, private readonly emit: Emit, private readonly initialize: () => Promise<void>) {}

  async start(): Promise<void> {
    if (!this.ready || this.started) return
    this.started = true
    this.unsubscribe.push(
      subscribeChanges(() => this.scheduleLive()),
      subscribeAdaptStore(() => this.scheduleLive()),
      subscribeAdaptActivity(() => this.scheduleLive()),
      onJournalWrite(() => this.scheduleLive()),
      queueManager.subscribe(() => this.scheduleLive()),
      updateManager.subscribe(() => this.scheduleLive()),
    )
    this.unsubscribe.push(this.queryClient.getQueryCache().subscribe(() => this.scheduleLive()))
    await this.beginWriters()
  }

  private async beginWriters(): Promise<void> {
    await applyStoredPreferences()
    try {
      await initializeRecording()
      startAdaptationRunner(this.queryClient)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The generation journal is unavailable. Choose a writable folder.'
      for (const adaptation of await listAdaptations()) {
        if (adaptation.status === 'active') await updateAdaptation(adaptation.id, { status: 'stopped', error: message })
      }
      this.emit({ event: 'notice', message })
    }
    queueManager.start()
    await this.scheduleUpdate()
  }

  async withStoppedJobs<T>(operation: () => Promise<T>): Promise<T> {
    if (this.maintaining) throw new Error('Local data maintenance is already running. Wait for it to finish.')
    this.maintaining = true
    this.controller.abort()
    clearTimeout(this.liveTimer)
    clearTimeout(this.updateTimer)
    this.liveTimer = undefined
    this.updateTimer = undefined
    this.liveAgain = false
    try {
      await Promise.allSettled([...this.loads, ...(this.liveWork ? [this.liveWork] : [])])
      await Promise.all([drainAdaptationRunner(), queueManager.stopAndDrain(), updateManager.cancelAndDrain()])
      await waitForDatabaseIdle()
      return await operation()
    } finally {
      this.maintaining = false
      if (!this.closed && this.ready) await this.beginWriters()
    }
  }

  private async scheduleUpdate(): Promise<void> {
    clearTimeout(this.updateTimer)
    if (this.closed || this.maintaining) return
    const prefs = await loadUpdatePrefs()
    if (prefs.intervalHours === 0) return
    const lastRun = await getLastRunAt()
    const checkedAt = Math.max(lastRun ?? 0, this.lastUpdateAttempt)
    const delay = checkedAt ? Math.max(0, checkedAt + prefs.intervalHours * 3_600_000 - Date.now()) : 0
    this.updateTimer = setTimeout(() => {
      if (this.closed || this.maintaining) return
      this.lastUpdateAttempt = Date.now()
      void updateManager.runUpdate().catch((error: unknown) => this.emit({ event: 'notice', message: error instanceof Error ? error.message : 'The library update failed. Retry from Updates.' })).finally(() => { if (!this.closed && !this.maintaining) void this.scheduleUpdate() })
    }, Math.min(delay, 2_147_000_000))
  }

  private async firstRun(): Promise<Screen> {
    return {
      route: 'home', routeKey: 'first-run', title: 'Your local library',
      subtitle: 'Keep your comics, novels, and adaptations on this device.',
      fonts: await bundledFontFiles(),
      sections: [section('create-library', 'Start reading', [], 'Create your local library, then import files or browse sources.', [action('Create local library', 'database.initialize')])],
    }
  }

  async navigate(route: string, p: Params = {}): Promise<Result> {
    if (!Object.hasOwn(ROUTES, route)) throw new Error('This screen does not exist.')
    if (this.maintaining) throw new Error('Local data maintenance is running. Wait for it to finish.')
    const previousReader = this.screen.reader
    if (route === 'reader' && this.screen.route === 'reader' && previousReader && p.chapterId === previousReader.chapterId && p.restart !== true) {
      p = { ...p, transientPosition: previousReader.position, refresh: true }
    }
    this.controller.abort()
    this.controller = new AbortController()
    this.routeParams = p
    if (!this.ready) {
      this.screen = await this.firstRun()
      return { screen: this.screen }
    }
    const key = `${route}:${++this.serial}`
    const previous = this.screen.route === route ? new Map(this.screen.sections.map((entry) => [entry.id, entry])) : new Map<string, Section>()
    const pending = (id: string, title?: string): Section => ({ ...previous.get(id), id, ...(title ? { title } : {}), status: 'loading' })
    const screen: Screen = { route, routeKey: key, title: '', sections: [] }
    const jobs: { id: string; run: Loader }[] = []
    const schedule = (id: string, title: string, run: Loader) => { screen.sections.push(pending(id, title)); jobs.push({ id, run }) }
    switch (route) {
      case 'home':
        screen.title = 'Home'
        screen.tabs = homeTabs(p)
        screen.actions = [navigate('Browse sources', 'browse')]
        schedule(p.tab === 'added' ? 'notStarted' : 'continue', p.tab === 'added' ? 'Not started' : 'Continue reading', () => homeSections(p))
        break
      case 'library': {
        screen.title = 'Library'
        screen.actions = [navigate('Manage categories', 'categories')]
        schedule('library-filters', 'Find a series', () => librarySections(p))
        break
      }
      case 'categories':
        screen.title = 'Categories'
        screen.actions = [action('Add category', 'category.edit')]
        schedule('categories', 'Your categories', () => categorySections())
        break
      case 'browse': {
        screen.title = 'Browse'
        screen.actions = [action('Import local files', 'local.import', {}, { pick: 'file', accept: ['cbz', 'zip', 'epub', 'txt', 'text'] }), action('Open comic folder', 'local.folder', {}, { variant: 'secondary', pick: 'folder' })]
        screen.sections = await browseSections(p)
        const query = string(p.query).trim()
        if (query) for (const source of listSources().filter((entry) => !p.kind || kindOf(entry) === p.kind)) jobs.push({ id: `search:${source.id}`, run: (signal) => globalSourceResults(source, query, signal) })
        break
      }
      case 'source': {
        const source = getSource(string(p.sourceId))
        screen.title = 'Browse source'
        screen.tabs = tabs('source', string(p.feed, 'popular'), [['popular', 'Popular'], ...(source.supportsLatest ? [['latest', 'Latest'] as [string, string]] : []), ...(source.getHotManga ? [['hot', 'Trending'] as [string, string]] : [])], { sourceId: source.id })
          .map((entry) => ({ ...entry, params: { sourceId: source.id, feed: entry.id } }))
        screen.sections.push(section('source-info', '', [{ id: source.id, title: source.name, subtitle: kindOf(source) === 'novel' ? 'Novels' : 'Comics', badges: sourceBadge(source) }], ''))
        schedule('source-filters', 'Search and filters', (signal) => sourceFilterSection(p, signal))
        schedule('source-results', 'Titles', (signal) => sourceResults(p, signal))
        break
      }
      case 'series': {
        const manga = await mangaOf(p)
        this.routeParams = { ...p, mangaId: manga.id }
        screen.title = manga.title
        screen.actions = [navigate('Continue reading', 'reader', { mangaId: manga.id }, true)]
        const seriesParams = { ...p, mangaId: manga.id }
        schedule('series-info', 'About this series', (signal) => seriesSections(seriesParams, signal))
        if (getSource(manga.sourceId).supportsRelatedMangas) schedule('related', 'Related series', (signal) => relatedSection({ mangaId: manga.id }, signal))
        break
      }
      case 'reader': {
        const manga = await mangaOf(p)
        this.routeParams = { ...p, mangaId: manga.id }
        screen.title = manga.title
        screen.actions = [navigate('Back to series', 'series', { mangaId: manga.id }), navigate('Reader settings', 'settings', { tab: 'reader' })]
        schedule('reader-content', 'Loading chapter', async (signal) => {
          const reader = await readerContent({ ...p, mangaId: manga.id }, signal, (message) => this.emit({ event: 'notice', message }))
          signal.throwIfAborted()
          if (this.screen.routeKey === key) {
            this.screen.reader = reader
            this.routeParams = { ...this.routeParams, chapterId: reader.chapterId }
            this.emit({ event: 'reader', routeKey: key, reader })
          }
          return readerControls({ ...p, mangaId: manga.id, chapterId: reader.chapterId })
        })
        break
      }
      case 'updates':
        screen.title = 'Updates'
        screen.actions = [action('Check updates', 'updates.start', {}, { cancelable: true }), action('Cancel update', 'updates.cancel', {}, { variant: 'secondary' })]
        schedule('updates', 'New chapters', () => updateSections())
        void markUpdatesSeen().catch(() => undefined)
        break
      case 'history':
        screen.title = 'History'
        schedule('history', 'Recently opened', () => historySections())
        break
      case 'downloads':
        screen.title = 'Downloads'
        schedule('download-status', 'Queue status', () => downloadsSection())
        break
      case 'adaptations':
        screen.title = 'Adaptations'
        screen.actions = [navigate('Browse novels', 'browse', { kind: 'novel' })]
        schedule('adaptations', 'Your adaptations', () => adaptationList())
        break
      case 'adaptation': {
        screen.title = 'Adaptation'
        screen.tabs = adaptationTabs(p)
        screen.actions = [navigate('Generation settings', 'settings', { tab: 'adapt' }), action('Delete adaptation', 'adapt.delete', { adaptationId: string(p.adaptationId) }, { variant: 'danger', confirm: 'Delete this adaptation, its generated files, and its journal records? The source novel remains.' })]
        const id = p.tab === 'read' ? 'adapt-read' : p.tab === 'cast' ? 'adapt-cast' : p.tab === 'props' ? 'adapt-props' : p.tab === 'style' ? 'adapt-style' : 'adapt-status'
        schedule(id, 'Your adaptation', () => adaptationSections(p))
        break
      }
      case 'journal':
        screen.title = 'Generation journal'
        screen.actions = [action('Export journal', 'journal.export', {}, { pick: 'save', variant: 'secondary' }), action('Choose journal folder', 'journal.folder', {}, { pick: 'folder', variant: 'secondary' })]
        schedule('journal-filters', 'Find a generation', () => journalSections(p))
        break
      case 'generation':
        screen.title = 'Generation details'
        screen.actions = [navigate('Back to journal', 'journal')]
        schedule('generation-output', 'Output', () => generationSections(p))
        break
      case 'settings': {
        screen.title = 'Settings'
        screen.tabs = settingsTabs(p)
        const firstSettingsId = p.tab === 'data' ? 'backup' : string(p.tab, 'appearance')
        schedule(firstSettingsId, 'Preferences', async (signal) => {
          await settingsSections(p, (section) => {
            if (!signal.aborted && this.screen.routeKey === key) this.replaceSection(section, key)
          })
        })
        break
      }
      case 'migrate': {
        const from = await mangaOf(p)
        this.routeParams = { ...p, mangaId: from.id }
        if (!from.favorite) throw new Error('Add this series to your library before migrating it.')
        const query = string(p.query, from.title)
        screen.title = 'Migrate series'
        screen.sections.push({ id: 'migration-search', title: from.title, status: 'ready', layout: 'form', fields: [field('query', 'Search replacement sources', query)], actions: [action('Find replacements', 'migrate.search', { mangaId: from.id }), navigate('Keep current source', 'series', { mangaId: from.id })] })
        for (const source of listSources().filter((entry) => entry.id !== from.sourceId && kindOf(entry) === from.contentKind && !entry.isLocal)) {
          const id = `migrate:${source.id}`
          schedule(id, source.name, async (signal) => {
            const found = await globalSourceResults(source, query, signal)
            return { ...found, id, rows: found.rows?.map((row) => ({ ...row, actions: [action('Choose replacement', 'migrate.review', { mangaId: from.id, toSourceId: source.id, url: row.id.slice(source.id.length + 1) })] })) }
          })
        }
        break
      }
    }
    const [theme, fonts] = await Promise.all([themeTokens(), installedFontFiles()])
    screen.theme = theme
    screen.fonts = fonts
    if (isIncognito()) screen.subtitle = 'Incognito reading: history and progress are not recorded.'
    if (this.undoAction) screen.actions = [action(this.undoAction.label, 'undo', {}, { variant: 'secondary' }), ...(screen.actions ?? [])]
    this.screen = screen
    const signal = this.controller.signal
    setImmediate(() => {
      for (const job of jobs) {
        const work: Promise<void> = this.load(key, job.id, () => job.run(signal), signal).finally(() => this.loads.delete(work))
        this.loads.add(work)
      }
    })
    return { screen }
  }

  private async load(key: string, id: string, loader: () => Promise<Section | Section[] | void>, signal: AbortSignal): Promise<void> {
    try {
      const loaded = await loader()
      if (signal.aborted || this.closed || this.screen.routeKey !== key) return
      if (loaded === undefined) return
      for (const section of Array.isArray(loaded) ? loaded : [loaded]) this.replaceSection(section, key)
    } catch (error) {
      if (signal.aborted || this.closed || this.screen.routeKey !== key) return
      this.replaceSection({ id, status: 'error', error: error instanceof Error ? error.message : 'This section could not load. Retry to reconnect.', actions: [action('Retry loading', 'screen.refresh', {}, { variant: 'secondary' })] }, key)
    }
  }

  private replaceSection(section: Section, key = this.screen.routeKey): void {
    const at = this.screen.sections.findIndex((entry) => entry.id === section.id)
    if (at < 0) this.screen.sections.push(section)
    else this.screen.sections[at] = section
    this.emit({ event: 'section', routeKey: key, section })
  }

  private scheduleLive(): void {
    if (this.closed || this.maintaining || !this.ready || !this.started) return
    if (this.liveTimer) return
    this.liveTimer = setTimeout(() => {
      this.liveTimer = undefined
      if (this.liveBusy) { this.liveAgain = true; return }
      this.liveBusy = true
      this.liveWork = this.refreshLive().catch((error: unknown) => this.emit({ event: 'notice', message: error instanceof Error ? error.message : 'Live progress could not refresh.' })).finally(() => {
        this.liveBusy = false
        this.liveWork = undefined
        if (this.liveAgain) { this.liveAgain = false; this.scheduleLive() }
      })
    }, 150)
  }

  private async refreshLive(): Promise<void> {
    const key = this.screen.routeKey
    const p = this.routeParams
    let sections: Section[] | undefined
    switch (this.screen.route) {
      case 'downloads': sections = await downloadsSection(); break
      case 'adaptations': sections = await adaptationList(); break
      case 'adaptation': sections = await adaptationSections(p); break
      case 'journal': sections = await journalSections(p); break
      case 'generation': sections = await generationSections(p); break
      case 'library': sections = await librarySections(p); break
      case 'home': sections = await homeSections(p); break
      case 'updates': sections = await updateSections(); break
    }
    if (key !== this.screen.routeKey || this.closed) return
    for (const section of sections ?? []) this.replaceSection(section, key)
  }

  async progress(p: Params): Promise<Result> {
    if (!this.ready) throw new Error('Create your local library before saving progress.')
    if (this.maintaining) throw new Error('Local data maintenance is running. Progress will resume afterward.')
    if (this.screen.reader?.chapterId === string(p.chapterId)) this.screen.reader.position = number(p.position) + number(p.offset)
    await recordProgress(p)
    return {}
  }

  async image(p: Params, signal: AbortSignal): Promise<Result> {
    if (!this.ready) throw new Error('Create your local library before loading images.')
    if (this.maintaining) throw new Error('Local data maintenance is running. Retry image loading afterward.')
    const raw = params(p.image)
    const sourceId = string(raw.sourceId)
    getSource(sourceId)
    const url = string(raw.url)
    if (!url) throw new Error('The image has no address.')
    const reference: ImageRef = { sourceId, url }
    if (raw.index !== undefined) reference.index = Math.max(0, Math.trunc(number(raw.index)))
    if (raw.descramble !== undefined) {
      const grid = params(raw.descramble)
      const cols = number(grid.cols)
      const rows = number(grid.rows)
      if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 1 || rows < 1 || !Array.isArray(grid.tiles) || grid.tiles.length !== cols * rows) throw new Error('The image tile layout is invalid.')
      const tiles = grid.tiles.map((item) => number(item))
      if (tiles.some((tile) => !Number.isSafeInteger(tile) || tile < 0 || tile >= cols * rows) || new Set(tiles).size !== tiles.length) throw new Error('The image tile layout is invalid.')
      reference.descramble = { cols, rows, tiles }
    }
    const image = await cacheSourceImage(sourceId, { index: reference.index ?? 0, imageUrl: url, ...(reference.descramble ? { descramble: reference.descramble } : {}) }, signal)
    return { image: { key: JSON.stringify(reference), ...image } }
  }

  async execute(actionValue: Action, values: Record<string, string>, selectedPaths: string[], signal: AbortSignal): Promise<Result> {
    if (actionValue.method === 'database.initialize') {
      if (this.ready) return this.navigate('home')
      await this.initialize()
      this.ready = true
      await this.start()
      return this.navigate('home')
    }
    if (!this.ready) throw new Error('Create your local library first.')
    if (actionValue.method === 'adapt.create' || actionValue.method === 'adapt.resume') {
      await initializeRecording()
      startAdaptationRunner(this.queryClient)
    }
    if (actionValue.method === 'screen.refresh') return this.navigate(this.screen.route, this.routeParams)
    if (actionValue.method === 'undo') {
      const undo = this.undoAction
      if (!undo) throw new Error('There is no recent removal to undo.')
      await undo.restore()
      this.undoAction = undefined
      return this.navigate(this.screen.route, this.routeParams)
    }
    const context: MutationContext = {
      screen: this.screen, params: this.routeParams, signal,
      navigate: (route, p = {}) => this.navigate(route, p),
      refresh: () => this.navigate(this.screen.route, this.routeParams),
      dialog: (dialog: Dialog) => {
        this.screen = { ...this.screen, dialog }
        return { screen: this.screen }
      },
      undo: (label, restore) => { this.undoAction = { label, restore } },
    }
    const result = await performAction(actionValue.method, actionValue.params ?? {}, values, selectedPaths, context)
    if (result.screen) {
      if (result.screen !== this.screen) {
        this.controller.abort()
        this.controller = new AbortController()
        const selectedTab = result.screen.tabs?.find((tab) => tab.selected)?.id
        this.routeParams = { ...this.routeParams, ...(selectedTab ? { tab: selectedTab } : {}) }
        this.screen = { ...result.screen, routeKey: `${result.screen.route}:${++this.serial}` }
      }
      return { ...result, screen: this.screen }
    }
    if (result.dialog) return { ...result, ...context.dialog(result.dialog) }
    if (result.navigate) return { ...result, ...await this.navigate(result.navigate.route, result.navigate.params ?? {}) }
    if (actionValue.method.startsWith('settings.') || actionValue.method.startsWith('theme.') || actionValue.method.startsWith('fonts.') || actionValue.method.startsWith('backup.') || actionValue.method.startsWith('mihon.') || actionValue.method.startsWith('storage.')) return { ...await this.navigate(this.screen.route, this.routeParams), ...result }
    return result
  }

  async close(): Promise<void> {
    this.closed = true
    this.controller.abort()
    clearTimeout(this.liveTimer)
    clearTimeout(this.updateTimer)
    for (const stop of this.unsubscribe.splice(0)) stop()
    await Promise.allSettled([...this.loads, ...(this.liveWork ? [this.liveWork] : [])])
    await Promise.all([drainAdaptationRunner(), queueManager.stopAndDrain(), updateManager.cancelAndDrain()])
    this.queryClient.clear()
  }
}
