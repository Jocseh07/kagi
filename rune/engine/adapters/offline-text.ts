import { getChapterText, markChapterSaved, saveChapterText, setChapterSavedBytes } from '../../../src/lib/db/repositories'
import type { ChapterText, SChapter, SManga, TextSource } from '../../../src/lib/sources/types'
import type { SaveChapterResult, SaveOptions } from '../../../src/lib/offline/types'
import { sqliteTransaction } from './database'
import { enforceSavedChapterLimit, markNativeOfflineJobCommitted, runNativeOfflineJob } from './offline'
import { storageFailure } from './storage'
export async function saveChapterTextOffline(chapterId: string, source: TextSource, manga: SManga, chapter: SChapter, options: SaveOptions = {}): Promise<SaveChapterResult> {
  return runNativeOfflineJob(chapterId,options,(next) => saveText(chapterId,source,manga,chapter,next))
}
async function saveText(chapterId: string, source: TextSource, manga: SManga, chapter: SChapter, options: SaveOptions): Promise<SaveChapterResult> {
  if (options.signal?.aborted) return {ok:false,reason:'cancelled',message:'Saving was cancelled.'}
  options.onProgress?.({phase:'fetching',completed:0,total:1})
  let text: ChapterText
  try { text = await source.getChapterText(manga,chapter,options.signal) }
  catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) return {ok:false,reason:'cancelled',message:'Saving was cancelled.'}
    return {ok:false,reason:'network',message:error instanceof Error ? error.message : String(error)}
  }
  if (options.signal?.aborted) return {ok:false,reason:'cancelled',message:'Saving was cancelled.'}
  if (!text.html.trim()) return {ok:false,reason:'no-pages',message:'This chapter came back empty. The source may have rate-limited the request or moved the chapter, so nothing was saved.'}
  options.onProgress?.({phase:'fetching',completed:1,total:1})
  const bytes = new TextEncoder().encode(text.html).length
  try {
    await sqliteTransaction(async () => {
      options.signal?.throwIfAborted()
      await saveChapterText(chapterId,text)
      if (!await markChapterSaved(chapterId,true,true)) throw new Error('The chapter was removed before it could be saved.')
      await setChapterSavedBytes(chapterId,bytes)
      options.signal?.throwIfAborted()
    })
  } catch (error) {
    if (options.signal?.aborted) return {ok:false,reason:'cancelled',message:'Saving was cancelled.'}
    const failure = storageFailure(error)
    return {ok:false,reason:failure.quota ? 'quota-exceeded' : 'network',message:failure.message}
  }
  markNativeOfflineJobCommitted(chapterId)
  try { await enforceSavedChapterLimit(chapterId) }
  catch (error) { console.error('Saved chapter limit enforcement failed:',error instanceof Error ? error.message : String(error)) }
  return {ok:true,pageCount:1,projectedBytes:bytes,measuredBytes:bytes}
}
export async function hasSavedText(chapterId: string): Promise<boolean> { return await getChapterText(chapterId) !== null }
