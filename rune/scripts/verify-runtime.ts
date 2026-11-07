import assert from 'node:assert/strict'
import { closeSync, fsyncSync, openSync, renameSync, statSync, writeSync } from 'node:fs'
import { readFile, readdir, readlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Action, Event, Params, Reader, Reply, Result, Screen } from '../engine/protocol'

export class Evidence {
  private fd: number
  private bytes = 0
  private part = 0
  readonly counts = { pass: 0, fail: 0, unavailable: 0 }
  readonly limitations = new Set<string>()
  constructor(readonly root: string, readonly seed: number) {
    this.fd = openSync(join(root, 'events-0.jsonl'), 'wx', 0o600)
  }
  emit(kind: string, data: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ at: new Date().toISOString(), seed: this.seed, kind, ...data }) + '\n'
    if (Buffer.byteLength(line) > 128 * 1024) throw new Error('Evidence row exceeds 128 KiB')
    if (this.bytes + Buffer.byteLength(line) > 16 * 1024 * 1024) {
      fsyncSync(this.fd); closeSync(this.fd)
      this.part = (this.part + 1) % 4
      this.fd = openSync(join(this.root, `events-${this.part}.jsonl`), 'w', 0o600)
      this.bytes = 0
    }
    const bytes = Buffer.from(line)
    let offset = 0
    while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset)
    this.bytes += bytes.length
    fsyncSync(this.fd)
  }
  unavailable(name: string, reason: string): void {
    if (this.limitations.has(name)) return
    this.limitations.add(name); this.counts.unavailable++
    this.emit('case', { name, status: 'unavailable', reason })
  }
  async case(name: string, expected: string, work: () => Promise<unknown>): Promise<boolean> {
    const start = performance.now()
    try {
      const observed = await work()
      this.counts.pass++
      this.emit('case', { name, expected, observed, status: 'pass', elapsedMs: performance.now() - start })
      return true
    } catch (error) {
      this.counts.fail++
      this.emit('case', { name, expected, status: 'fail', error: error instanceof Error ? error.message : String(error), elapsedMs: performance.now() - start })
      return false
    }
  }
  finish(summary: Record<string, unknown>): void {
    this.emit('summary', { ...summary, counts: this.counts, verdict: this.counts.fail ? 'fail' : this.counts.unavailable ? 'incomplete' : 'pass' })
    fsyncSync(this.fd); closeSync(this.fd)
  }
}

export class Histogram {
  private readonly bins = new Uint32Array(8192)
  count = 0
  max = 0
  add(ms: number): void {
    assert(Number.isFinite(ms) && ms >= 0)
    this.bins[Math.min(this.bins.length - 1, Math.ceil(ms * 4))]++
    this.count++; this.max = Math.max(this.max, ms)
  }
  p95(): number | null {
    if (!this.count) return null
    let n = 0
    for (let i = 0; i < this.bins.length; i++) {
      n += this.bins[i]
      if (n >= Math.ceil(this.count * 0.95)) return i === this.bins.length - 1 ? this.max : i / 4
    }
    return null
  }
  result(): Record<string, unknown> { return { count: this.count, p95MsUpperBound: this.p95(), maxMs: this.max, resolutionMs: 0.25 } }
}

export class Trend {
  n = 0
  private x = 0
  private y = 0
  private xx = 0
  private xy = 0
  private initial = 0
  add(seconds: number, value: number): void {
    if (!this.n) this.initial = value
    this.n++; this.x += seconds; this.y += value; this.xx += seconds * seconds; this.xy += seconds * value
  }
  growthPerHour(): number | null {
    const denominator = this.n * this.xx - this.x * this.x
    return this.n < 30 || denominator <= 0 || this.initial <= 0 ? null : ((this.n * this.xy - this.x * this.y) / denominator) * 3600 / this.initial * 100
  }
}

export function random(seed: number): () => number {
  let state = seed >>> 0
  return () => { state += 0x6d2b79f5; let n = state; n = Math.imul(n ^ n >>> 15, n | 1); n ^= n + Math.imul(n ^ n >>> 7, n | 61); return ((n ^ n >>> 14) >>> 0) / 4294967296 }
}
export function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}
export async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, deadlineMs = 30_000): Promise<T> {
  const end = performance.now() + deadlineMs
  while (true) {
    const value = await read()
    if (accept(value)) return value
    if (performance.now() >= end) throw new Error(`Condition did not complete within ${deadlineMs} ms`)
    await delay(25)
  }
}

export interface Resource { pid: number; role: string; executable: string; rssBytes: number; cpuSeconds: number; fds: number; threads: number; startTicks: string }
export async function resource(pid: number, role: string, ticks: number, pageSize: number): Promise<Resource | undefined> {
  try {
    const [raw, memory, descriptors, executable] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readFile(`/proc/${pid}/statm`, 'utf8'), readdir(`/proc/${pid}/fd`), readlink(`/proc/${pid}/exe`)])
    const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)
    const measuredRole = role === 'tracer' ? role : basename(executable).includes('kagi-rune') ? 'ui' : /bun|kagi-engine/.test(basename(executable)) ? 'engine' : role
    return { pid, role: measuredRole, executable, rssBytes: Number(memory.trim().split(/\s+/)[1]) * pageSize, cpuSeconds: (Number(fields[11]) + Number(fields[12])) / ticks, fds: descriptors.length, threads: Number(fields[17]), startTicks: fields[19] }
  } catch { return undefined }
}

export class ProcessGuard {
  violations = 0
  private readonly children = new Set<ChildProcessWithoutNullStreams>()
  constructor(readonly evidence: Evidence, readonly port: number, readonly env: NodeJS.ProcessEnv) {}
  start(command: string[], role: string, onLine?: (line: string) => void): ChildProcessWithoutNullStreams {
    const child = spawn('strace', ['-f', '-qq', '-s', '256', '-e', 'trace=connect', '--', ...command], { env: this.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.children.add(child)
    const errors = createInterface({ input: child.stderr })
    let diagnostics = 0
    errors.on('line', (line) => {
      if (line.startsWith('KAGI_VERIFY_BLOCKED ')) {
        this.violations++
        this.evidence.emit('forbidden-network', { role, line: line.slice(0, 1024), preventedBy: 'verification preload before fetch' })
        killTree(child, 'SIGKILL')
        return
      }
      if (/connect\(.*sa_family=AF_INET6?/.test(line)) {
        const allowed = line.includes(`htons(${this.port})`) && (line.includes('inet_addr("127.0.0.1")') || line.includes('inet_pton(AF_INET6, "::1"'))
        if (!allowed) { this.violations++; this.evidence.emit('forbidden-network', { role, line: line.slice(0, 1024) }); killTree(child, 'SIGKILL') }
      } else if (line.length < 4096) {
        onLine?.(line)
        if (diagnostics++ < 32) this.evidence.emit('process-diagnostic', { role, line })
      }
    })
    child.once('error', (error) => { this.evidence.emit('process-error', { role, error: error.message }) })
    child.once('close', () => { errors.close(); this.children.delete(child) })
    return child
  }
  async stop(): Promise<void> {
    await Promise.all([...this.children].map(async (child) => {
      killTree(child, 'SIGTERM')
      const timeout = setTimeout(() => killTree(child, 'SIGKILL'), 3000)
      await exited(child)
      clearTimeout(timeout)
    }))
  }
  async samples(ticks: number, pageSize: number): Promise<Resource[]> {
    const output: Resource[] = []
    for (const child of this.children) {
      if (!child.pid) continue
      const pending = [child.pid]
      for (let i = 0; i < pending.length && pending.length < 256; i++) {
        const pid = pending[i]
        const sample = await resource(pid, pid === child.pid ? 'tracer' : 'app-or-engine', ticks, pageSize)
        if (sample && sample.role !== 'tracer') output.push(sample)
        try {
          const text = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')
          pending.push(...text.trim().split(/\s+/).filter(Boolean).map(Number))
        } catch {}
      }
    }
    return output
  }
}

export class RpcError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
interface Pending { resolve(value: Result): void; reject(error: Error): void; timer: NodeJS.Timeout }
export class Engine {
  private nextId = 0
  private readonly pending = new Map<number, Pending>()
  private readonly screens = new Map<string, Screen>()
  private fatal: Error | undefined
  readonly latency: Map<string, Histogram>
  readonly process: ChildProcessWithoutNullStreams
  private readonly input: Interface
  constructor(command: string[], guard: ProcessGuard, readonly evidence: Evidence, latency = new Map<string, Histogram>()) {
    this.latency = latency
    this.process = guard.start(command, 'engine')
    this.input = createInterface({ input: this.process.stdout, crlfDelay: Infinity })
    this.input.on('line', (line) => {
      try {
        if (line.length > 16 * 1024 * 1024) throw new Error('Engine RPC line exceeds 16 MiB')
        const message = JSON.parse(line) as Reply | Event
        if ('id' in message) {
          const request = this.pending.get(message.id)
          if (!request) throw new Error('Unmatched or duplicate engine reply')
          clearTimeout(request.timer); this.pending.delete(message.id)
          if (message.ok) {
            if (message.result.screen) this.merge(message.result.screen)
            request.resolve(message.result)
          } else request.reject(new RpcError(message.error.code, message.error.message))
        } else if (message.event === 'section' || message.event === 'reader') {
          const screen = this.screens.get(message.routeKey)
          if (!screen) return
          if (message.event === 'reader') screen.reader = message.reader
          else {
            const index = screen.sections.findIndex((entry) => entry.id === message.section.id)
            if (index < 0) screen.sections.push(message.section); else screen.sections[index] = message.section
          }
        }
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
    })
    this.process.once('error', (error) => this.fail(error))
    this.process.once('close', (code, signal) => this.fail(new Error(`Engine exited: ${code ?? signal}`)))
  }
  private merge(screen: Screen): void {
    this.screens.set(screen.routeKey, screen)
    while (this.screens.size > 4) this.screens.delete(this.screens.keys().next().value!)
  }
  private fail(error: Error): void {
    this.fatal = error
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error) }
    this.pending.clear()
  }
  request(method: string, params: Params = {}, timeout = 60_000): { id: number; result: Promise<Result> } {
    const id = ++this.nextId
    const start = performance.now()
    const { promise, resolve, reject } = Promise.withResolvers<Result>()
    if (this.fatal) { reject(this.fatal); return { id, result: promise } }
    if (this.pending.size >= 64) { reject(new Error('Harness pending RPC bound exceeded')); return { id, result: promise } }
    const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeout} ms`)) }, timeout)
    this.pending.set(id, { resolve, reject, timer })
    this.process.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    return { id, result: promise.finally(() => {
      const name = method === 'action' ? `action:${(params.action as unknown as Action)?.method}` : method === 'navigate' ? `navigate:${params.route}` : method
      let histogram = this.latency.get(name)
      if (!histogram) { histogram = new Histogram(); this.latency.set(name, histogram) }
      histogram.add(performance.now() - start)
    }) }
  }
  call(method: string, params: Params = {}, timeout?: number): Promise<Result> { return this.request(method, params, timeout).result }
  action(method: string, params: Params = {}, values: Record<string, string> = {}, selectedPaths: string[] = [], timeout?: number): Promise<Result> {
    return this.call('action', { action: { id: `${method}:${JSON.stringify(params)}`, label: method, method, params }, values, selectedPaths }, timeout)
  }
  async screen(route: string, params: Params = {}): Promise<Screen> {
    const result = await this.call('navigate', { route, params })
    assert(result.screen, `${route} returned no screen`)
    const screen = result.screen
    await until(() => {
      if (this.fatal) throw this.fatal
      return screen
    }, (value) => value.sections.every((section) => section.status !== 'loading'))
    const errors = screen.sections.filter((section) => section.status === 'error')
    assert.deepEqual(errors.map((section) => section.error), [], `${route} section failure`)
    return screen
  }
  async reader(params: Params): Promise<Reader> {
    const screen = await this.screen('reader', params)
    assert(screen.reader, 'Reader content event missing')
    return screen.reader
  }
  async stop(crash = false): Promise<void> {
    if (crash) killTree(this.process, 'SIGKILL')
    else {
      await this.call('shutdown').catch(() => undefined)
      this.process.stdin.end()
    }
    const timer = setTimeout(() => killTree(this.process, 'SIGKILL'), 5000)
    await exited(this.process)
    clearTimeout(timer); this.input.close()
  }
}

export function checkedFile(path: string): string {
  assert(statSync(path).isFile(), `Missing executable or bundle: ${path}`)
  return path
}
export function replaceReport(path: string, value: unknown): void {
  const temporary = `${path}.new`
  const fd = openSync(temporary, 'wx', 0o600)
  try { writeSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, path)
}

export function killTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  try { process.kill(-child.pid, signal) } catch {}
}
export function exited(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  const { promise, resolve } = Promise.withResolvers<void>()
  child.once('close', () => resolve())
  return promise
}
