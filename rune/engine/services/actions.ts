import { eq } from 'drizzle-orm'
import * as repository from '@/lib/db/repositories'
import * as categories from '@/lib/db/categories'
import * as history from '@/lib/db/history'
import { history as historyTable } from '@/lib/db/schema'
import { db, transact, getDeviceId } from '@/lib/db/client'
import { assertFacts, chapterKeysOf } from '@/lib/db/facts'
import { PRESENT, encodeLabel } from '@/lib/sync/fact-kinds'
import { bumpChangeSignal } from '@/lib/db/change-signal'
import { adoptSeriesDates } from '@/lib/db/series-migration'
import * as queue from '@/lib/download/queue-repository'
import { queueManager } from '@/lib/download/queue-manager'
import { updateManager } from '@/lib/updates/update-manager'
import { isConfigurable } from '@/lib/sources/types'
import { loadSourcePrefs } from '@/lib/sources/preferences'
import { setIncognito, isIncognito } from '@/lib/incognito/store'
import { migrateSeries } from '@/lib/migrate/migrate-series'
import { unsaveChapter } from '@/lib/offline/save-chapter'
import { chapterOf, mangaOf, sourceOf, sourceManga, refreshManga, enqueue, bookmarkChapter, exportChapter, adjacentChapter, librarySelection, applyLibrarySelection, applyFilters } from './library'
import { getSourceFilters, setSourceFilters } from '../screens/sources'
import { adaptationAction } from './adaptation'
import { journalAction } from './journal'
import { settingsAction } from './settings'
import { importLocalFiles } from '../adapters/local-files'
import type { Params, Result, Field } from '../protocol'
import { string, number, strings } from '../protocol'
import { action, field } from '../screens/helpers'
import type { MutationContext } from './context'

export async function performAction(method: string, p: Params, values: Record<string, string>, selectedPaths: string[], context: MutationContext): Promise<Result> {
  const adaptation = await adaptationAction(method, p, values, selectedPaths, context)
  if (adaptation) return adaptation
  const journal = await journalAction(method, p, values, selectedPaths, context)
  if (journal) return journal
  const setting = await settingsAction(method, p, values, selectedPaths)
  if (setting) return setting
  switch (method) {
    case 'navigate': {
      const { route, compareFromField, ...next } = p
      if (compareFromField === true) next.comparison = values.comparison ?? ''
      return context.navigate(string(route), next)
    }
    case 'dialog.close': return context.refresh()
    case 'browse.search': return context.navigate('browse', { query: values.query ?? '', kind: values.kind ?? '' })
    case 'source.filter': {
      const sourceId = string(p.sourceId)
      setSourceFilters(sourceId, applyFilters(getSourceFilters(sourceId), values))
      return context.navigate('source', { sourceId, query: values.query ?? '', filtered: true, page: 1 })
    }
    case 'source.preferences': {
      const source = await sourceOf(string(p.sourceId))
      if (!isConfigurable(source)) throw new Error('This source has no preferences.')
      const prefs = await loadSourcePrefs(source)
      const fields: Field[] = source.getPreferences().map((entry) => field(entry.key, entry.title, prefs[entry.key], entry.type === 'switch' ? 'toggle' : entry.type === 'select' ? 'select' : /password|token|secret|api.key/i.test(entry.key) ? 'password' : 'text', entry.values, entry.summary))
      return context.dialog({ id: 'source-preferences', title: `${source.name} preferences`, fields, actions: [action('Save preferences', 'source.preferences.save', { sourceId: source.id })] })
    }
    case 'source.preferences.save': {
      const source = await sourceOf(string(p.sourceId))
      if (!isConfigurable(source)) throw new Error('This source has no preferences.')
      for (const entry of source.getPreferences()) {
        const value = values[entry.key]
        if (value === undefined) continue
        if (entry.type === 'select' && !entry.values?.some((option) => option.value === value)) throw new Error(`Choose an available value for ${entry.title}.`)
        await repository.setSourcePref(source.id, entry.key, entry.type === 'switch' ? String(value === 'true') : value)
      }
      await loadSourcePrefs(source)
      return { ...await context.refresh(), notice: 'Source preferences saved.' }
    }
    case 'series.refresh': {
      const manga = await refreshManga(await mangaOf(p), context.signal)
      return context.navigate('series', { mangaId: manga.id })
    }
    case 'series.filter': return context.navigate('series', { ...p, query: values.query ?? '', chapterFilter: values.chapterFilter ?? '', scanlator: values.scanlator ?? '', order: values.order ?? 'number', ascending: values.ascending ?? 'true' })
    case 'series.favorite': {
      const manga = await mangaOf(p)
      const favorite = p.favorite === true
      const previousCategories = favorite ? [] : await categories.getMangaCategories(manga.id)
      await repository.setFavorite(manga.id, favorite)
      if (!favorite) context.undo('Undo removal', async () => {
        await repository.setFavorite(manga.id, true)
        await adoptSeriesDates(manga.id, { dateAdded: manga.dateAdded, lastRead: (await repository.getManga(manga.id))?.lastRead ?? manga.lastRead })
        await categories.setMangaCategories(manga.id, previousCategories)
      })
      return context.refresh()
    }
    case 'library.filter': {
      const next: Params = { ...values }
      await repository.setSetting('native.library.view', JSON.stringify(next))
      return context.navigate('library', next)
    }
    case 'library.select': {
      const id = string(p.mangaId)
      if (!await repository.getManga(id)) throw new Error('This series no longer exists.')
      if (librarySelection.has(id)) librarySelection.delete(id)
      else librarySelection.add(id)
      return context.refresh()
    }
    case 'library.clearSelection': librarySelection.clear(); return context.refresh()
    case 'library.bulk': {
      const operation = string(p.operation)
      if (operation !== 'read' && operation !== 'unread' && operation !== 'remove') throw new Error('Choose a library operation.')
      if (operation === 'remove') {
        const snapshots = (await Promise.all([...librarySelection].map(async (id) => ({ manga: await repository.getManga(id), categories: await categories.getMangaCategories(id) })))).filter((entry) => entry.manga !== null)
        await applyLibrarySelection(operation)
        context.undo('Undo removal', async () => {
          for (const entry of snapshots) {
            if (!entry.manga) continue
            await repository.setFavorite(entry.manga.id, true)
            await adoptSeriesDates(entry.manga.id, { dateAdded: entry.manga.dateAdded, lastRead: (await repository.getManga(entry.manga.id))?.lastRead ?? entry.manga.lastRead })
            await categories.setMangaCategories(entry.manga.id, entry.categories)
          }
        })
      } else await applyLibrarySelection(operation)
      return context.refresh()
    }
    case 'library.categories': {
      const list = await categories.listCategories()
      const chosen = p.mangaId ? [string(p.mangaId)] : [...librarySelection]
      if (!chosen.length) throw new Error('Select a series before assigning categories.')
      const assignments = await categories.getCategoriesForManga(chosen)
      return context.dialog({ id: 'assign-categories', title: 'Assign categories', fields: list.map((entry) => field(`category:${entry.id}`, entry.name, chosen.every((id) => assignments[id]?.includes(entry.id)), 'toggle')), actions: [action('Save categories', 'library.categories.save', { mangaIds: chosen })] })
    }
    case 'library.categories.save': {
      const ids = strings(p.mangaIds)
      const list = await categories.listCategories()
      await categories.setCategoriesForManga(ids, list.filter((entry) => values[`category:${entry.id}`] === 'true').map((entry) => entry.id))
      return context.refresh()
    }
    case 'category.edit': {
      const id = string(p.categoryId)
      const existing = id ? (await categories.listCategories()).find((entry) => entry.id === id) : undefined
      if (id && !existing) throw new Error('This category no longer exists.')
      return context.dialog({ id: 'category-editor', title: id ? 'Rename category' : 'Create category', fields: [field('categoryName', 'Category name', existing?.name ?? '')], actions: [action('Save category', 'category.save', id ? { categoryId: id } : {})] })
    }
    case 'category.save': {
      const id = string(p.categoryId)
      if (id) await categories.renameCategory(id, values.categoryName ?? '')
      else await categories.createCategory(values.categoryName ?? '')
      return context.refresh()
    }
    case 'category.delete': await categories.deleteCategory(string(p.categoryId)); return context.refresh()
    case 'category.move': {
      const list = await categories.listCategories()
      const at = list.findIndex((entry) => entry.id === p.categoryId)
      const next = at + (number(p.direction) < 0 ? -1 : 1)
      if (at < 0 || next < 0 || next >= list.length) throw new Error('This category cannot move further in that direction.')
      const moved = list.splice(at, 1)[0]
      list.splice(next, 0, moved)
      await categories.reorderCategories(list.map((entry) => entry.id))
      return context.refresh()
    }
    case 'chapter.read': await repository.markChapterRead(string(p.chapterId), p.read === true); return context.refresh()
    case 'chapter.bookmark': await bookmarkChapter(string(p.chapterId), p.bookmarked === true); return context.refresh()
    case 'chapter.save': {
      const chapter = await chapterOf(string(p.chapterId))
      await enqueue(chapter.mangaId, [chapter.id])
      return { ...await context.refresh(), notice: 'Chapter added to downloads.' }
    }
    case 'series.saveUnread': {
      const manga = await mangaOf(p)
      const count = await enqueue(manga.id)
      return { ...await context.refresh(), notice: `${count} chapters added to downloads.` }
    }
    case 'chapter.unsave': await unsaveChapter(string(p.chapterId)); return context.refresh()
    case 'chapter.export': {
      const destination = selectedPaths[0]
      if (!destination) throw new Error('Choose where to export the chapter.')
      await exportChapter(string(p.chapterId), destination, context.signal)
      return { exportPath: destination, notice: 'Chapter exported.' }
    }
    case 'reader.next':
    case 'reader.previous': {
      const chapter = await adjacentChapter(string(p.chapterId), method === 'reader.next' ? 1 : -1)
      if (!chapter) throw new Error(method === 'reader.next' ? 'You have reached the last chapter.' : 'You are at the first chapter.')
      return context.navigate('reader', { mangaId: chapter.mangaId, chapterId: chapter.id })
    }
    case 'reader.restart': return context.navigate('reader', { ...context.params, restart: true })
    case 'reader.chapter': {
      const chapter = await chapterOf(values.chapterId ?? '')
      return context.navigate('reader', { mangaId: chapter.mangaId, chapterId: chapter.id })
    }
    case 'reader.incognito': setIncognito(!isIncognito()); return context.refresh()
    case 'downloads.pause': await queueManager.pause(); return context.refresh()
    case 'downloads.resume': await queueManager.resume(); return context.refresh()
    case 'downloads.clearFinished': await queue.clearFinished(); return context.refresh()
    case 'downloads.retry': await queue.retryItem(string(p.queueId)); queueManager.nudge(); return context.refresh()
    case 'downloads.remove': queueManager.cancelItem(string(p.queueId)); await queue.removeItem(string(p.queueId)); return context.refresh()
    case 'downloads.item.pause': {
      const id = string(p.queueId)
      queueManager.cancelItem(id)
      await queue.setItemState(id, 'paused')
      return context.refresh()
    }
    case 'downloads.item.resume': await queue.setItemState(string(p.queueId), 'queued'); queueManager.nudge(); return context.refresh()
    case 'downloads.move': await queue.reorderItem(string(p.queueId), number(p.position)); queueManager.nudge(); return context.refresh()
    case 'updates.start': {
      const result = await updateManager.runUpdate({ signal: context.signal })
      return { ...await context.refresh(), notice: `${result.newChapters} new chapters found.` }
    }
    case 'updates.cancel': await updateManager.cancelAndDrain(); return context.refresh()
    case 'history.clear': await history.clearHistory(); return context.refresh()
    case 'history.remove': {
      const id = string(p.historyId)
      const [saved] = await db.select().from(historyTable).where(eq(historyTable.id, id)).limit(1)
      if (!saved) throw new Error('This history entry no longer exists.')
      await history.deleteHistoryEntry(id)
      context.undo('Undo removal', async () => {
        await transact(async (tx) => {
          const [key] = await chapterKeysOf(tx, [saved.chapterId])
          if (!key) throw new Error('The original chapter no longer exists.')
          await tx.insert(historyTable).values({ ...saved, updatedAt: Date.now(), deviceId: getDeviceId() }).onConflictDoNothing()
          await assertFacts(tx, [{ kind: 'hist', key: key.key, state: PRESENT, val: saved.readAt, payload: encodeLabel({ n: key.name, i: key.chapterNumber }), bump: true }])
        })
        bumpChangeSignal()
      })
      return context.refresh()
    }
    case 'local.import':
    case 'local.folder': {
      if (!selectedPaths.length) throw new Error('Choose local files or a folder to import.')
      await importLocalFiles(selectedPaths)
      return context.navigate('browse', { notice: 'Local files imported.' })
    }
    case 'migrate.search': return context.navigate('migrate', { mangaId: string(p.mangaId), query: values.query ?? '' })
    case 'migrate.review': {
      const from = await mangaOf({ mangaId: string(p.mangaId) })
      const target = await mangaOf({ sourceId: string(p.toSourceId), url: string(p.url) })
      if (from.contentKind !== target.contentKind) throw new Error('Choose a replacement with the same content kind.')
      return context.dialog({ id: 'migrate-series', title: 'Move this series?', description: `${from.title} → ${target.title}`, fields: [field('chapters', 'Carry reading progress and bookmarks', true, 'toggle'), field('categories', 'Carry categories', true, 'toggle'), field('removeOld', 'Remove the old library entry', false, 'toggle'), field('deleteDownloads', 'Delete old saved chapters', false, 'toggle')], actions: [action('Transfer series', 'migrate.apply', { mangaId: from.id, targetId: target.id }, { confirm: 'Transfer these choices to the selected source? Requested removals and saved-file deletions cannot be undone.' })] })
    }
    case 'migrate.apply': {
      const from = await mangaOf({ mangaId: string(p.mangaId) })
      const target = await mangaOf({ mangaId: string(p.targetId) })
      const source = await sourceOf(target.sourceId)
      const updated = await source.getMangaUpdate(sourceManga(target), { fetchDetails: true, fetchChapters: true }, context.signal)
      const result = await migrateSeries({ from, toSourceId: source.id, toManga: updated.manga, toChapters: updated.chapters, options: { chapters: values.chapters === 'true', categories: values.categories === 'true', removeOld: values.removeOld === 'true', deleteDownloads: values.deleteDownloads === 'true' } })
      return { ...await context.navigate('series', { mangaId: result.mangaId }), notice: `${result.chaptersMatched} chapters matched.` }
    }
    default: throw new Error('This action is not available. Reload the current screen.')
  }
}
