import { parseArgs } from 'node:util'
import { dirname, resolve, join } from 'node:path'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { configureRuntimeDatabase, databaseStatus, initializeRuntimeDatabase, defaultDataRoot } from './database-runtime'
import { closeDatabase, initDb } from './adapters/database'
import type { Action, Event, Params, Reply, Request, Result } from './protocol'
import { isRequest, params, string, strings } from './protocol'
import { acquireEngineLock } from './process-lock'
import { configureStorage } from './adapters/storage'
import { configureContent } from './adapters/image-runtime'
import { configureSettings, configureSettingsMaintenance } from './services/settings'
import { configureCanvasFonts } from './adapters/canvas'
import { readAdaptConnection } from './adapters/settings'
import { NativeApplication } from './app'
import { rehydrateOnBoot, pauseAll } from '@/lib/download/queue-repository'
import { listAdaptations, updateAdaptation } from '@/lib/adapt/store'

const MAX_REQUEST_BYTES = 16 * 1024 * 1024
const MAX_PENDING_REQUESTS = 64

type Message = Reply | Event

class Outbox {
  private readonly replies: Reply[] = []
  private readonly events = new Map<string, Event>()
  private running: Promise<void> | undefined
  private broken = false

  constructor(private readonly onBroken: () => void) {}

  send(message: Message): void {
    if (this.broken) return
    if ('id' in message) this.replies.push(message)
    else {
      const key = message.event === 'section' ? `${message.routeKey}:${message.section.id}` : message.event === 'reader' ? `${message.routeKey}:reader` : message.event
      this.events.set(key, message)
    }
    this.sendNext()
  }

  private sendNext(): void {
    this.running ??= Promise.resolve().then(() => this.flush()).catch(() => {
      this.broken = true
      this.replies.length = 0
      this.events.clear()
      this.onBroken()
    }).finally(() => {
      this.running = undefined
      if (!this.broken && (this.replies.length || this.events.size)) this.sendNext()
    })
  }

  private async flush(): Promise<void> {
    while (this.replies.length || this.events.size) {
      let message: Message | undefined = this.replies.shift()
      if (!message) {
        const entry = this.events.entries().next().value
        if (entry) { this.events.delete(entry[0]); message = entry[1] }
      }
      if (!message) continue
      const encoded = JSON.stringify(message, (_key, value: unknown) => typeof value === 'string' ? value.toWellFormed() : value)
      if (!process.stdout.write(`${encoded}\n`)) await once(process.stdout, 'drain')
    }
  }

  async drain(): Promise<void> {
    await this.running
  }
}

function actionInput(value: unknown): Action {
  if (!value || typeof value !== 'object' || !('method' in value) || typeof value.method !== 'string' || !('id' in value) || typeof value.id !== 'string' || !('label' in value) || typeof value.label !== 'string') throw new Error('The action request is invalid.')
  const p = 'params' in value ? params(value.params as Params) : undefined
  return { id: value.id, method: value.method, label: value.label, ...(p ? { params: p } : {}) }
}

function fieldValues(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The entered values are invalid.')
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new Error('The entered values must be text.')
    if (!['__proto__', 'prototype', 'constructor'].includes(key)) result[key] = entry
  }
  return result
}

async function* requestLines(): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let pieces: string[] = []
  let bytes = 0
  let overflowing = false
  for await (const chunk of Bun.stdin.stream()) {
    const text = decoder.decode(chunk, { stream: true })
    const parts = text.split('\n')
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]
      bytes += Buffer.byteLength(part)
      if (bytes > MAX_REQUEST_BYTES) { pieces = []; overflowing = true }
      else if (!overflowing) pieces.push(part)
      if (index !== parts.length - 1) {
        if (overflowing) yield ''
        else yield pieces.join('')
        pieces = []
        bytes = 0
        overflowing = false
      }
    }
  }
  const remaining = decoder.decode()
  if (remaining) pieces.push(remaining)
  const finalLine = pieces.join('')
  if (finalLine && !overflowing) yield finalLine
}

async function serve(root: string, assetsRoot: string): Promise<void> {
  const unlock = await acquireEngineLock(root)
  const output = new Outbox(() => process.stdin.destroy())
  const pending = new Map<number, { method: string; controller: AbortController; work: Promise<void> }>()
  const actionWork = new Map<string, Promise<Result>>()
  let mutationTail: Promise<void> = Promise.resolve()
  let closing = false
  let shutdown: Promise<void> | undefined
  configureSettings(root, assetsRoot)
  const configure = async () => {
    await configureStorage(root)
    configureContent(root)
    configureCanvasFonts({ inter: join(assetsRoot, 'fonts/inter-latin-wght-normal.woff2'), comicNeue: join(assetsRoot, 'fonts/comic-neue-latin-700-normal.woff2') })
  }
  const initial = databaseStatus()
  if (initial.ready) { await initDb(); await configure() }
  const app = new NativeApplication(initial.ready, (event) => output.send(event), async () => {
    await initializeRuntimeDatabase()
    await configure()
  })
  configureSettingsMaintenance({
    withStoppedJobs: (operation) => app.withStoppedJobs(async () => {
      const readers = [...pending.values()].filter((entry) => entry.method === 'image.resolve')
      for (const entry of readers) entry.controller.abort()
      await Promise.allSettled(readers.map((entry) => entry.work))
      return operation()
    }),
    initializeRestoredDatabase: async () => {
      await initializeRuntimeDatabase()
      await rehydrateOnBoot()
      await pauseAll()
      for (const adaptation of await listAdaptations()) {
        if (adaptation.status === 'active') await updateAdaptation(adaptation.id, { status: 'paused', error: null })
      }
    },
  })
  if (initial.ready) await app.start()
  const diagnostic = console.error.bind(console)
  console.log = (...values: unknown[]) => diagnostic(...values)

  const safeMessage = async (error: unknown): Promise<string> => {
    let message = error instanceof Error ? error.message : 'The action failed. Retry from the current screen.'
    if (!databaseStatus().ready) return message
    try {
      const { apiKey: secret } = await readAdaptConnection()
      if (secret && message.includes(secret)) message = secret.length < 8 ? 'The provider request failed. Check your endpoint and API key.' : message.replaceAll(secret, '[redacted]')
    } catch {
      return 'The action failed and private settings could not be read. Check local storage.'
    }
    return message
  }

  const stop = (): Promise<void> => {
    shutdown ??= (async () => {
      closing = true
      for (const entry of pending.values()) entry.controller.abort()
      await Promise.allSettled([...pending.values()].map((entry) => entry.work))
      try {
        await app.close()
        await closeDatabase()
        await output.drain()
      } finally {
        unlock()
      }
    })()
    return shutdown
  }
  const signalStop = () => { process.stdin.destroy(); void stop().finally(() => process.exit(0)) }
  process.once('SIGTERM', signalStop)
  process.once('SIGINT', signalStop)

  const handle = async (request: Request, controller: AbortController): Promise<void> => {
    try {
      const p = request.params ?? {}
      let result: Result
      switch (request.method) {
        case 'navigate': {
          const route = string(p.route, 'home')
          const { route: _route, params: nested, ...flat } = p
          const work = mutationTail.then(() => app.navigate(route, nested === undefined ? flat : params(nested)))
          mutationTail = work.then(() => undefined, () => undefined)
          result = await work
          break
        }
        case 'reader.progress': {
          const work = mutationTail.then(() => app.progress(p))
          mutationTail = work.then(() => undefined, () => undefined)
          result = await work
          break
        }
        case 'image.resolve': result = await app.image(p, controller.signal); break
        case 'database.status': result = { database: databaseStatus() }; break
        case 'action': {
          const selected = actionInput(p.action)
          const values = fieldValues(p.values)
          const paths = strings(p.selectedPaths)
          const key = createHash('sha256').update(JSON.stringify([selected.method, selected.params, values, paths])).digest('hex')
          let shared = actionWork.get(key)
          if (!shared) {
            shared = mutationTail.then(async () => {
              controller.signal.throwIfAborted()
              return app.execute(selected, values, paths, controller.signal)
            })
            actionWork.set(key, shared)
            mutationTail = shared.then(() => undefined, () => undefined)
            void shared.finally(() => { if (actionWork.get(key) === shared) actionWork.delete(key) }).catch(() => undefined)
          }
          result = await shared
          break
        }
        case 'ping': result = { version: '0.1.0', database: databaseStatus().ready }; break
        case 'shutdown':
          result = {}
          setImmediate(() => { process.stdin.destroy(); void stop() })
          break
        default: throw new Error('This engine method is not available.')
      }
      output.send({ id: request.id, ok: true, result })
    } catch (error) {
      output.send({ id: request.id, ok: false, error: { code: controller.signal.aborted ? 'CANCELED' : 'ACTION_FAILED', message: await safeMessage(error) } })
    }
  }

  try {
    for await (const line of requestLines()) {
      if (closing) break
      if (!line.trim()) { output.send({ event: 'notice', message: 'The request exceeded the input limit or was empty.' }); continue }
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { output.send({ event: 'notice', message: 'The app sent unreadable data. Reload the current screen.' }); continue }
      if (!isRequest(parsed)) { output.send({ event: 'notice', message: 'The app sent an invalid request. Reload the current screen.' }); continue }
      if (parsed.method === 'cancel') {
        const target = parsed.params?.requestId
        if (typeof target !== 'number' || !Number.isSafeInteger(target)) output.send({ id: parsed.id, ok: false, error: { code: 'INVALID_REQUEST', message: 'Choose an active request to cancel.' } })
        else { pending.get(target)?.controller.abort(); output.send({ id: parsed.id, ok: true, result: { canceled: pending.has(target) } }) }
        continue
      }
      if (pending.has(parsed.id)) { output.send({ event: 'notice', message: 'The app reused an active request ID. Wait for that action to finish.' }); continue }
      if (pending.size >= MAX_PENDING_REQUESTS) { output.send({ id: parsed.id, ok: false, error: { code: 'BUSY', message: 'Too much work is queued. Wait for an active action to finish.' } }); continue }
      const controller = new AbortController()
      const work = handle(parsed, controller).finally(() => pending.delete(parsed.id))
      pending.set(parsed.id, { method: parsed.method, controller, work })
    }
  } catch (error) {
    if (!closing) diagnostic(await safeMessage(error))
  } finally {
    await stop()
    process.off('SIGTERM', signalStop)
    process.off('SIGINT', signalStop)
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: {
    'data-dir': { type: 'string' }, 'assets-dir': { type: 'string' },
    status: { type: 'boolean' }, schema: { type: 'boolean' }, initialize: { type: 'boolean' },
  } })
  const root = resolve(values['data-dir'] ?? defaultDataRoot())
  configureRuntimeDatabase(root)
  if (values.status || values.schema) {
    process.stdout.write(`${JSON.stringify(databaseStatus(), null, 2)}\n`)
    return
  }
  if (values.initialize) {
    const unlock = await acquireEngineLock(root)
    try {
      await initializeRuntimeDatabase()
      process.stdout.write(`${JSON.stringify(databaseStatus(), null, 2)}\n`)
      await closeDatabase()
    } finally { unlock() }
    return
  }
  const assetsRoot = resolve(values['assets-dir'] ?? process.env.KAGI_ASSETS_DIR ?? dirname(process.execPath))
  await serve(root, assetsRoot)
}

if (import.meta.main) await main()
