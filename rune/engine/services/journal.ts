import { journalStore } from '@/lib/adapt/journal/store'
import { getReplacementImpact, applyGeneration } from '@/lib/adapt/journal/replacement'
import { replayGeneration } from '@/lib/adapt/journal/replay'
import { deleteJournalGeneration } from '@/lib/adapt/journal/files'
import { readAdaptSettings } from '../adapters/settings'
import { exportJournalTo, importJournalFrom, setJournalFolder } from '../adapters/journal-files'
import { atomicExport } from './files'
import type { Params, Result } from '../protocol'
import { string } from '../protocol'
import { action, field } from '../screens/helpers'
import type { MutationContext } from './context'

export async function journalAction(method: string, p: Params, values: Record<string, string>, selectedPaths: string[], context: MutationContext): Promise<Result | undefined> {
  if (method === 'journal.filter') return context.navigate('journal', { ...p, query: values.query ?? '', stage: values.stage ?? '', status: values.status ?? '' })
  if (method === 'journal.export') {
    const destination = selectedPaths[0]
    if (!destination) throw new Error('Choose where to save the journal.')
    const id = string(p.generationId)
    await exportJournalTo(destination, id ? [id] : undefined)
    return { exportPath: destination, notice: 'Journal exported.' }
  }
  if (method === 'journal.import') {
    const path = selectedPaths[0]
    if (!path) throw new Error('Choose a journal ZIP to import.')
    const count = await importJournalFrom(path)
    return { ...await context.refresh(), notice: `${count} journal records imported.` }
  }
  if (method === 'journal.folder') {
    const path = selectedPaths[0]
    if (!path) throw new Error('Choose a folder for your journal.')
    await setJournalFolder(path)
    return { ...await context.refresh(), notice: 'Journal folder saved.' }
  }
  if (!method.startsWith('generation.')) return undefined
  const id = string(p.generationId)
  const run = await journalStore.getRun(id)
  if (!run) throw new Error('This generation no longer exists.')
  switch (method) {
    case 'generation.retry': {
      const connection = await readAdaptSettings()
      if (!connection.endpoint) throw new Error('Add your local endpoint in Adapt settings first.')
      const attempt = values.attempt ? Number(values.attempt) : undefined
      if (attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt < 1)) throw new Error('Choose an existing attempt number.')
      const result = await replayGeneration(journalStore, run.id, {
        endpoint: connection.endpoint, apiKey: connection.apiKey, model: values.model?.trim() || run.model,
        ...(values.prompt?.trim() ? { prompt: values.prompt } : {}), ...(attempt !== undefined ? { attempt } : {}),
        maxRequests: 1, signal: context.signal,
      })
      return { ...await context.navigate('generation', { generationId: result.id, comparison: run.id }), notice: result.status === 'succeeded' ? 'Comparison saved.' : result.status === 'cancelled' ? 'Retry canceled. Its evidence is saved.' : 'Retry failed. Inspect its saved evidence.' }
    }
    case 'generation.review': {
      const impact = await getReplacementImpact(run, journalStore)
      return context.dialog({ id: 'apply-generation', title: 'Apply this generation?', description: impact.title, fields: impact.details.map((detail, index) => ({ ...field(`impact:${index}`, 'Affected work', detail, 'multiline'), disabled: true })), actions: [action('Apply replacement', 'generation.apply', { generationId: run.id }, { variant: 'danger', confirm: 'Apply this replacement to the affected work? The original journal record remains.' })] })
    }
    case 'generation.apply':
      await getReplacementImpact(run, journalStore)
      await applyGeneration(run, journalStore)
      return { ...await context.refresh(), notice: 'Replacement applied.' }
    case 'generation.delete':
      if (run.status === 'running') throw new Error('Wait for this generation to finish before deleting it.')
      await deleteJournalGeneration(run.id)
      return context.navigate('journal')
    case 'generation.artifact': {
      const artifact = await journalStore.getArtifact(string(p.artifactId))
      if (!artifact || artifact.generationId !== run.id) throw new Error('This saved file does not belong to the generation.')
      const destination = selectedPaths[0]
      if (!destination) throw new Error('Choose where to export this saved file.')
      await atomicExport(destination, artifact.blob)
      return { exportPath: destination, notice: 'Saved file exported.' }
    }
    case 'generation.compare': {
      const comparison = values.comparison
      if (!comparison) throw new Error('Choose a related generation to compare.')
      return context.navigate('generation', { generationId: run.id, comparison })
    }
    default: throw new Error('This journal action is not available.')
  }
}
