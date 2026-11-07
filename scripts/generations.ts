import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { createFileJournal } from '../desktop/src/journal-store'
import { getBundle } from '../src/lib/adapt/journal/store'
import { isJournalId, validateBundle } from '../src/lib/adapt/journal/helpers'
import { replayGeneration } from '../src/lib/adapt/journal/replay'

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      dir: { type: 'string' },
      endpoint: { type: 'string' },
      attempt: { type: 'string' },
      model: { type: 'string' },
      'prompt-file': { type: 'string' },
      'max-requests': { type: 'string', default: '1' },
      'timeout-ms': { type: 'string', default: '1800000' },
      help: { type: 'boolean' },
    },
  })
  if (values.help) {
    console.log(JSON.stringify({ usage: 'bun scripts/generations.ts <list|show|retry|compare|propose-apply> [id] [other-id] --dir <journal-folder>', retry: '--endpoint <explicit-url> [--attempt N] [--model MODEL] [--prompt-file PATH] [--max-requests 1..6] [--timeout-ms 1..3600000]', credentials: 'KAGI_GENERATION_API_KEY environment variable; never restored from journal', proposals: 'propose-apply marks a successful child generation for confirmation in the app; never changes the adaptation' }))
    return
  }
  const [command, id, otherId] = positionals
  if (!['list', 'show', 'retry', 'compare', 'propose-apply'].includes(command ?? '')) throw new Error('Expected list, show, retry, compare, or propose-apply. Use --help for usage.')
  if (!values.dir) throw new Error('--dir is required; use the recording folder shown in the app')
  if (positionals.length !== (command === 'list' ? 1 : command === 'compare' ? 3 : 2)) throw new Error('Unexpected or missing command arguments')
  if (command !== 'list' && !isJournalId(id)) throw new Error('A valid generation UUID is required')
  if (command === 'compare' && !isJournalId(otherId)) throw new Error('A second valid generation UUID is required')
  if (command !== 'retry' && (values.endpoint || values.attempt || values.model || values['prompt-file'])) throw new Error('Replay options are valid only for retry')
  const store = await createFileJournal(values.dir)
  if (command === 'list') {
    console.log(JSON.stringify(await store.listRuns()))
    return
  }
  const bundle = await getBundle(store, id)
  await validateBundle(bundle)
  if (command === 'show') {
    console.log(JSON.stringify({ ...bundle, artifacts: bundle.artifacts.map(({ blob: _blob, ...artifact }) => artifact) }))
    return
  }
  if (command === 'compare') {
    const other = await getBundle(store, otherId)
    await validateBundle(other)
    console.log(JSON.stringify({
      original: bundle.run,
      candidate: other.run,
      sameOutput: JSON.stringify(bundle.run.output) === JSON.stringify(other.run.output) &&
        bundle.artifacts.find((artifact) => artifact.id === bundle.run.outputArtifactId)?.sha256 === other.artifacts.find((artifact) => artifact.id === other.run.outputArtifactId)?.sha256,
      originalArtifacts: bundle.artifacts.map(({ blob: _blob, ...artifact }) => artifact),
      candidateArtifacts: other.artifacts.map(({ blob: _blob, ...artifact }) => artifact),
    }))
    return
  }
  if (command === 'propose-apply') {
    if (bundle.run.status !== 'succeeded' || !bundle.run.parentId || !bundle.run.target) throw new Error('Only a successful linked replay with an adaptation target can be proposed')
    if (bundle.run.appliedAt) throw new Error('This generation was already applied')
    const proposed = { ...bundle.run, applicationRequested: true, updatedAt: Math.max(Date.now(), bundle.run.updatedAt + 1) }
    await store.putRun(proposed)
    console.log(JSON.stringify({ generation: proposed, applied: false, confirmationRequired: true }))
    return
  }
  if (!values.endpoint) throw new Error('--endpoint is required; a recorded endpoint is never selected automatically')
  const endpoint = new URL(values.endpoint)
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Endpoint must be an HTTP(S) URL without credentials, query, or fragment')
  const apiKey = process.env.KAGI_GENERATION_API_KEY
  if (!apiKey) throw new Error('Set current credentials in KAGI_GENERATION_API_KEY')
  const maxRequests = Number(values['max-requests'])
  const timeout = Number(values['timeout-ms'])
  const attempt = values.attempt === undefined ? undefined : Number(values.attempt)
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 6) throw new Error('--max-requests must be an integer from 1 to 6')
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3_600_000) throw new Error('--timeout-ms must be an integer from 1 to 3600000')
  if (attempt !== undefined && (!Number.isInteger(attempt) || attempt < 1)) throw new Error('--attempt must be a positive integer')
  const prompt = values['prompt-file'] ? await readFile(values['prompt-file'], 'utf8') : undefined
  const controller = new AbortController()
  const interrupt = () => controller.abort(new Error('Replay interrupted'))
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    const run = await replayGeneration(store, id, {
      endpoint: endpoint.href,
      apiKey,
      attempt,
      model: values.model,
      prompt,
      maxRequests,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]),
    })
    console.log(JSON.stringify(run))
    if (run.status !== 'succeeded') process.exitCode = 1
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
  }
}

main().catch((error: unknown) => {
  const credential = process.env.KAGI_GENERATION_API_KEY
  const message = error instanceof Error ? error.message : String(error)
  console.error(JSON.stringify({ error: credential ? message.replaceAll(credential, '[redacted]') : message }))
  process.exitCode = 1
})
