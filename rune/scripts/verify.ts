import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { mkdir, readFile, readlink, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { createFixtures, FIXTURES, MODELS, validateFixtures } from './verify-fixtures'
import { Engine, Evidence, Histogram, ProcessGuard, Trend, checkedFile, exited, killTree, random, replaceReport } from './verify-runtime'
import { mixedAction, repeatActions, runFunctional, runLargeFixtures, runProviderEdges, type ScenarioContext } from './verify-scenarios'
import { nativeVerification } from './verify-native'
import { runIntegrity } from './verify-integrity'
import { cachePressure } from './verify-cache'
import { runDownloads } from './verify-downloads'
import type { ProviderControl, ProviderHandle, ProviderStats } from './verify-provider'

const PROJECT = resolve(import.meta.dir, '../..')
const SANDBOX = join(PROJECT, '.tmp/stress-rune-native')
interface Options { seed: number; repeat: number; soakSeconds: number; idleSeconds: number; dataDir: string; engine: string; ui?: string; assets: string }
interface InsideConfig extends Options { run: string; parentNetwork: string; allowDatabaseInitialize: true }

function integer(raw: string | undefined, fallback: number, max: number): number {
  const value = raw === undefined ? fallback : Number(raw)
  assert(Number.isSafeInteger(value) && value >= 0 && value <= max, `Expected integer 0..${max}, received ${raw}`)
  return value
}
function contained(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === '' || (!part.startsWith('..') && !isAbsolute(part))
}
function cleanPath(path: string): string {
  const absolute = resolve(path)
  assert(contained(SANDBOX, absolute) && absolute !== SANDBOX, `Scratch path must be inside ${SANDBOX}`)
  let ancestor = absolute
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  assert.equal(realpathSync(ancestor), ancestor, 'Scratch path traverses a symlink')
  for (let current = ancestor; contained(PROJECT, current); current = dirname(current)) {
    assert(!lstatSync(current).isSymbolicLink(), `Scratch path contains symlink: ${current}`)
    if (current === PROJECT) break
  }
  return absolute
}
function command(engine: string, data: string, assets: string): string[] {
  return [...(/\.[cm]?js$/.test(engine) ? [process.execPath, engine] : [engine]), '--data-dir', data, '--assets-dir', assets]
}
function prerequisite(args: string[]): never {
  const invocation = ['bun run rune:verify --', ...args.filter((arg) => arg !== '--'), '--allow-database-initialize'].join(' ')
  throw new Error(`Database approval required. Nothing was initialized or executed.\nAfter the parent obtains separate user approval, run exactly:\n${invocation}\nThis authorizes creation/migration, local fixture imports, scratch backup restore and Mihon import only in a new run directory under --data-dir. The database is <new-run>/data/library.sqlite. No existing app or browser data is used. Pending migrations are logged from database.status before database.initialize.`)
}
async function outer(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const { values } = parseArgs({ args, strict: true, options: {
    offline: { type: 'boolean' }, seed: { type: 'string' }, repeat: { type: 'string' }, 'soak-seconds': { type: 'string' }, 'idle-seconds': { type: 'string' },
    'data-dir': { type: 'string' }, engine: { type: 'string' }, ui: { type: 'string' }, 'assets-dir': { type: 'string' }, 'allow-database-initialize': { type: 'boolean' },
  } })
  assert(values.offline, 'Only --offline is supported. Live providers and source requests are forbidden.')
  assert(values['data-dir'], 'Pass an explicit --data-dir inside .tmp/stress-rune-native/.')
  if (!values['allow-database-initialize']) prerequisite(args)
  const dataDir = cleanPath(values['data-dir'])
  const packaged = join(PROJECT, 'rune/dist/current/kagi-rune-linux-x64')
  const built = existsSync(join(packaged, 'bin/kagi-engine')) ? join(packaged, 'bin/kagi-engine') : join(PROJECT, 'rune/engine/dist/main.js')
  const engine = checkedFile(resolve(values.engine ?? built))
  const native = [join(packaged, 'bin/kagi-rune'), join(PROJECT, 'rune/target/x86_64-unknown-linux-gnu/release/kagi-rune'), join(PROJECT, 'rune/target/release/kagi-rune'), join(PROJECT, 'rune/target/debug/kagi-rune')].find((path) => existsSync(path))
  const ui = values.ui ? checkedFile(resolve(values.ui)) : native
  const assets = resolve(values['assets-dir'] ?? (existsSync(join(dirname(engine), '../assets/fonts/catalog.json')) ? join(dirname(engine), '../assets') : existsSync(join(dirname(engine), 'fonts/catalog.json')) ? dirname(engine) : join(PROJECT, '.tmp/rune-assets')))
  checkedFile(join(assets, 'fonts/catalog.json'))
  const options: Options = { seed: integer(values.seed, 429, 0xffffffff), repeat: integer(values.repeat, 50, 1000), soakSeconds: integer(values['soak-seconds'], 1200, 86400), idleSeconds: integer(values['idle-seconds'], 300, 3600), dataDir, engine, ui, assets }
  for (const binary of ['bwrap', 'strace', 'ip', 'getconf']) assert(Bun.which(binary), `Required offline isolation/measurement tool unavailable: ${binary}. No unisolated fallback is permitted.`)
  const run = join(dataDir, `run-${options.seed}-${Date.now()}-${randomUUID().slice(0, 8)}`)
  await mkdir(join(run, 'home'), { recursive: true, mode: 0o700 })
  await mkdir(join(run, 'data'), { mode: 0o700 })
  await mkdir(join(run, 'fault-volume'), { mode: 0o700 })
  await mkdir(join(run, 'tmp'), { mode: 0o700 })
  const config: InsideConfig = { ...options, run, parentNetwork: await readlink('/proc/self/ns/net'), allowDatabaseInitialize: true }
  const configPath = join(run, 'config.json')
  await Bun.write(configPath, JSON.stringify(config))
  const env: string[] = ['--setenv', 'PATH', process.env.PATH ?? '/usr/bin:/bin', '--setenv', 'HOME', join(run, 'home'), '--setenv', 'TMPDIR', join(run, 'tmp'), '--setenv', 'XDG_CACHE_HOME', join(run, 'home/cache'), '--setenv', 'XDG_CONFIG_HOME', join(run, 'home/config'), '--setenv', 'XDG_DATA_HOME', join(run, 'home/data'), '--setenv', 'KAGI_ASSETS_DIR', options.assets, '--setenv', 'NO_PROXY', '*']
  env.push('--setenv', 'TZ', 'UTC')
  for (const key of ['WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DISPLAY', 'LIBGL_DRIVERS_PATH', 'VK_ICD_FILENAMES']) if (process.env[key]) env.push('--setenv', key, process.env[key]!)
  const masks = (await readdir(PROJECT)).filter((name) => /^\.env(?:\.|$)/.test(name)).flatMap((name) => ['--ro-bind', '/dev/null', join(PROJECT, name)])
  const gpu = existsSync('/dev/dri') ? ['--dev-bind', '/dev/dri', '/dev/dri'] : []
  const invocation = ['bwrap', '--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-net', '--cap-add', 'CAP_NET_ADMIN', '--cap-add', 'CAP_SYS_PTRACE', '--ro-bind', '/', '/', '--bind', run, run, ...masks, '--proc', '/proc', '--dev', '/dev', ...gpu, '--size', String(1024 * 1024), '--tmpfs', join(run, 'fault-volume'), '--clearenv', ...env, '--chdir', run, process.execPath, import.meta.filename, '--inside', configPath]
  console.log(`Offline scratch run: ${run}\nDatabase approval: explicit --allow-database-initialize\nNetwork: private namespace, no external routes, strace connect audit\nReports: ${join(run, 'report.json')}`)
  const child = spawn(invocation[0], invocation.slice(1), { stdio: 'inherit' })
  const done = Promise.withResolvers<number>()
  child.once('error', done.reject)
  child.once('close', (code) => done.resolve(code ?? 1))
  const forward = () => child.kill('SIGTERM')
  process.once('SIGINT', forward); process.once('SIGTERM', forward)
  try { process.exitCode = await done.promise } finally { process.off('SIGINT', forward); process.off('SIGTERM', forward) }
}

async function providerProcess(root: string, image: string): Promise<{ handle: ProviderHandle; child: ChildProcessWithoutNullStreams }> {
  const child = spawn(process.execPath, [join(import.meta.dir, 'verify-provider.ts'), image], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  const ready = Promise.withResolvers<string>()
  const stdout = createInterface({ input: child.stdout })
  stdout.once('line', (line) => {
    try {
      const data: unknown = JSON.parse(line)
      assert(data && typeof data === 'object' && 'endpoint' in data && typeof data.endpoint === 'string')
      const url = new URL(data.endpoint)
      assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.pathname, '/v1')
      ready.resolve(data.endpoint)
    } catch (error) { ready.reject(error) }
  })
  const stderr = createInterface({ input: child.stderr })
  stderr.on('line', (line) => console.error(`fixture-provider: ${line.slice(0, 1024)}`))
  child.once('error', ready.reject)
  child.once('close', (code) => ready.reject(new Error(`Offline provider exited ${code}`)))
  const timeout = setTimeout(() => ready.reject(new Error('Offline provider did not start within 30 seconds')), 30_000)
  let endpoint: string
  try { endpoint = await ready.promise } catch (error) { killTree(child, 'SIGKILL'); throw error } finally { clearTimeout(timeout) }
  const handle: ProviderHandle = {
    endpoint,
    async control(value: ProviderControl): Promise<ProviderStats> {
      const response = await fetch(endpoint.replace('/v1', '/__control'), { method: 'POST', body: JSON.stringify(value), signal: AbortSignal.timeout(3000), headers: { 'Content-Type': 'application/json' } })
      assert(response.ok)
      return await response.json() as ProviderStats
    },
    async stop() { child.stdin.end(); const timer = setTimeout(() => killTree(child, 'SIGKILL'), 3000); try { await exited(child) } finally { clearTimeout(timer); stdout.close(); stderr.close() } },
  }
  await Bun.write(join(root, 'provider.json'), JSON.stringify({ endpoint, image }))
  return { handle, child }
}

async function inside(configPath: string): Promise<void> {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as InsideConfig
  assert(config.allowDatabaseInitialize === true, 'Internal configuration lacks explicit database authorization')
  assert(contained(SANDBOX, config.run) && contained(config.run, configPath), 'Invalid scratch configuration')
  assert.notEqual(await readlink('/proc/self/ns/net'), config.parentNetwork, 'Offline network namespace was not established')
  const links = spawnSync('ip', ['-json', 'link', 'show'], { encoding: 'utf8' })
  assert.equal(links.status, 0, 'Cannot inspect isolated network interfaces')
  const interfaces = JSON.parse(links.stdout) as { ifname: string }[]
  assert.deepEqual(interfaces.map((entry) => entry.ifname).sort(), ['lo'], 'Unexpected external network interface in offline namespace')
  const ip = spawnSync('ip', ['link', 'set', 'lo', 'up'], { encoding: 'utf8' })
  assert.equal(ip.status, 0, `Cannot enable isolated loopback: ${ip.stderr}`)
  const ticks = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim())
  const pageSize = Number(spawnSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }).stdout.trim())
  assert(ticks > 0 && pageSize > 0, 'Kernel sampling constants unavailable')
  const evidence = new Evidence(config.run, config.seed)
  const metadata = { seed: config.seed, models: MODELS, priority: false, repeat: config.repeat, soakSeconds: config.soakSeconds, idleSeconds: config.idleSeconds, runeRevision: 'ae8dfeb87cfad081fa87dc38d215ed0d1ba417a7', engineSha256: createHash('sha256').update(await Bun.file(config.engine).arrayBuffer().then((bytes) => new Uint8Array(bytes))).digest('hex'), bun: Bun.version, load: (await readFile('/proc/loadavg', 'utf8')).trim(), networkNamespace: await readlink('/proc/self/ns/net'), measuredWithStrace: true }
  evidence.emit('metadata', metadata)
  let guard: ProcessGuard | undefined
  let provider: ProviderHandle | undefined
  let engine: Engine | undefined
  let sampleTimer: NodeJS.Timeout | undefined
  let sampling = Promise.resolve()
  let sampleBusy = false
  let phase = 'functional'
  const data = join(config.run, 'data')
  const latencies = new Map<string, Histogram>()
  const rpcLatency = new Map<string, Histogram>()
  const soakTrend = new Trend()
  let soakStart = 0
  let mixedIterations = 0
  const signal = new AbortController()
  const stop = () => signal.abort(new Error('Verification interrupted'))
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    await validateFixtures()
    const fixtures = await createFixtures(join(config.run, 'fixtures'))
    evidence.emit('fixtures', { hash: fixtures.hash, root: fixtures.root })
    provider = (await providerProcess(config.run, fixtures.image)).handle
    const engineEnvironment = { ...process.env, KAGI_VERIFY_PROVIDER_URL: provider.endpoint, KAGI_VERIFY_RUN: config.run, BUN_OPTIONS: `--preload ${join(import.meta.dir, 'verify-preload.ts')}` }
    guard = new ProcessGuard(evidence, Number(new URL(provider.endpoint).port), engineEnvironment)
    const rpcCommand = command(config.engine, data, config.assets)
    engine = new Engine(rpcCommand, guard, evidence, rpcLatency)
    const sample = async (action?: string) => {
      if (!guard) return
      const processes = await guard.samples(ticks, pageSize)
      const rssBytes = processes.reduce((sum, process) => sum + process.rssBytes, 0)
      const memory = await readFile('/proc/meminfo', 'utf8')
      const available = Number(/MemAvailable:\s+(\d+)/.exec(memory)?.[1] ?? 0) * 1024
      evidence.emit('sample', { phase, action, processes, rssBytes, machineAvailableBytes: available, harnessHeapBytes: process.memoryUsage().heapUsed })
      if (available < 1024 ** 3) evidence.unavailable('memory-pressure-validity', 'Machine MemAvailable fell below 1 GiB, invalidating speed comparisons')
      if (phase === 'soak' && performance.now() - soakStart >= config.soakSeconds * 200) soakTrend.add((performance.now() - soakStart) / 1000, rssBytes)
    }
    sampleTimer = setInterval(() => {
      if (sampleBusy) return
      sampleBusy = true
      sampling = sample().catch((error: unknown) => { evidence.emit('sampler-error', { error: String(error) }); evidence.unavailable('complete-process-sampling', 'A process sampler read failed; inspect sampler-error rows') }).finally(() => { sampleBusy = false })
    }, 1000)
    const context: ScenarioContext = {
      engine, evidence, fixtures, provider, root: config.run,
      async restart(crash = false) {
        await context.engine.stop(crash)
        assert(guard)
        context.engine = new Engine(rpcCommand, guard, evidence, rpcLatency)
        engine = context.engine
        await context.engine.call('ping')
      },
      async timed(name, work) {
        signal.signal.throwIfAborted()
        const start = performance.now()
        await work()
        let histogram = latencies.get(name)
        if (!histogram) { histogram = new Histogram(); latencies.set(name, histogram) }
        histogram.add(performance.now() - start)
        await sample(name)
      },
    }
    const state = await runFunctional(context)
    phase = 'baselines'
    const baseline: Record<string, number[]> = { startup: [], decode: [], composition: [] }
    const measureBaseline = async (name: string, work: () => Promise<unknown>) => {
      const start = performance.now(); await work(); const ms = performance.now() - start
      baseline[name].push(ms); evidence.emit('baseline', { name, run: baseline[name].length, ms })
    }
    for (let i = 0; i < 3; i++) {
      await measureBaseline('startup', () => context.restart())
      await measureBaseline('decode', async () => {
        const reader = await context.engine.reader({ mangaId: state.comic.mangaId, chapterId: state.comic.chapterId })
        const reference = reader.pages?.[1]?.imageRef
        assert(reference)
        const image = (await context.engine.call('image.resolve', { image: reference as unknown as Record<string, never> })).image
        assert(image && typeof image === 'object' && 'width' in image && image.width === 4096 && 'height' in image && image.height === 4096)
      })
      await measureBaseline('composition', () => context.engine.action('adapt.text.save', { adaptationId: state.adaptationId, chapter: 1, page: 1, panel: 1 }, { dialogue: JSON.stringify(FIXTURES[0].pages[0].panels[0].text) }))
    }
    for (const [name, samples] of Object.entries(baseline)) {
      const sorted = [...samples].sort((a, b) => a - b)
      const p95 = sorted[sorted.length - 1], spread = sorted[sorted.length - 1] - sorted[0]
      const budget = p95 + Math.max(p95 * 0.1, spread)
      evidence.emit('baseline-budget', { name, samples, p95Ms: p95, spreadMs: spread, budgetMs: budget, definition: name === 'startup' ? 'engine restart through ping; not first visible pixel' : name === 'decode' ? 'reader RPC plus large source image decode/cache' : 'saved-panel text update plus awaited real composition and persistence' })
      const final: number[] = []
      for (let run = 0; run < 3; run++) {
        const start = performance.now()
        if (name === 'startup') await context.restart()
        else if (name === 'decode') {
          const reader = await context.engine.reader({ mangaId: state.comic.mangaId, chapterId: state.comic.chapterId })
          assert(reader.pages?.[1]?.imageRef)
          await context.engine.call('image.resolve', { image: reader.pages[1].imageRef as unknown as Record<string, never> })
        } else await context.engine.action('adapt.text.save', { adaptationId: state.adaptationId, chapter: 1, page: 1, panel: 1 }, { dialogue: JSON.stringify(FIXTURES[0].pages[0].panels[0].text) })
        final.push(performance.now() - start)
      }
      await evidence.case(`baseline-budget-${name}`, 'At most one of three unchanged-workload measurements exceeds baseline p95 plus max(10%, spread)', async () => { assert(final.filter((ms) => ms > budget).length < 2); return { samplesMs: final, budgetMs: budget } })
    }
    const download = await runDownloads(context)
    phase = 'repeat'
    await repeatActions(context, state, config.repeat, download)
    if (config.repeat < 50) evidence.unavailable('repeat50', `--repeat ${config.repeat} is shorter than the required 50 repeats per main action`)
    await runLargeFixtures(context)
    await cachePressure(context)
    phase = 'soak'; soakStart = performance.now()
    const choose = random(config.seed)
    while (performance.now() - soakStart < config.soakSeconds * 1000) {
      signal.signal.throwIfAborted()
      const passed = await evidence.case('mixed-workload', 'Seeded local actions preserve reader pages, library membership and bookmark state', async () => { await mixedAction(context, state, choose()); return { iteration: ++mixedIterations } })
      if (!passed) break
    }
    const growth = soakTrend.growthPerHour()
    if (config.soakSeconds < 1200) evidence.unavailable('full-soak-duration', `Requested ${config.soakSeconds}s is shorter than required 1200s`)
    if (growth === null) evidence.unavailable('soak-rss-budget', 'Fewer than 30 postwarmup process samples')
    else await evidence.case('soak-rss-budget', 'Postwarmup total engine RSS growth below 5% per hour', async () => {
      assert(growth < 5, `RSS growth ${growth}%/h exceeds 5%/h`)
      return { growthPercentPerHour: growth, iterations: mixedIterations }
    })
    phase = 'native'
    await context.engine.stop()
    await nativeVerification({ ui: config.ui, engine: config.engine, data, root: config.run, idleSeconds: config.idleSeconds, ticks, pageSize }, state.comic, guard, evidence)
    context.engine = new Engine(rpcCommand, guard, evidence, rpcLatency); engine = context.engine
    phase = 'edges'
    await runProviderEdges(context, state)
    await runIntegrity(context, state)
    const providerStats = await provider.control({ stats: true })
    await evidence.case('provider-policy', 'No unexpected provider requests, implicit Priority use, or active fixture work remain', async () => { assert.equal(providerStats.unexpected, 0); assert.equal(providerStats.priority, 0); assert.equal(providerStats.active, 0); assert.equal(providerStats.sourceActive, 0); return providerStats })
    for (const [name, histogram] of context.engine.latency) evidence.emit('rpc-latency', { name, ...histogram.result(), scope: 'engine acknowledgement, not native input-to-visible latency' })
    await evidence.case('engine-local-ack-budget', 'Local navigation acknowledgement p95 at most 50 ms, separately from unavailable native input-to-visible latency', async () => {
      const measured = [...rpcLatency.entries()].filter(([name]) => ['navigate:home', 'navigate:library', 'navigate:history', 'navigate:settings'].includes(name))
      assert(measured.length >= 3)
      for (const [name, histogram] of measured) assert((histogram.p95() ?? Infinity) <= 50, `${name} acknowledgement p95 exceeds 50 ms`)
      return Object.fromEntries(measured.map(([name, histogram]) => [name, histogram.result()]))
    })
    for (const [name, histogram] of latencies) evidence.emit('action-latency', { name, ...histogram.result() })
    await evidence.case('external-network', 'Zero external connection attempts; kernel namespace prevents egress', async () => { assert.equal(guard?.violations, 0); return { violations: guard?.violations } })
  } catch (error) {
    evidence.counts.fail++
    evidence.emit('fatal', { phase, error: error instanceof Error ? error.stack : String(error) })
  } finally {
    clearInterval(sampleTimer)
    await sampling
    if (engine) await engine.stop().catch(() => undefined)
    if (guard) await guard.stop()
    if (provider) await provider.stop()
    process.off('SIGINT', stop); process.off('SIGTERM', stop)
    const limits = [
      ['disk-full-db-image-midwrite', 'Kernel ENOSPC is exercised on atomic exports. The engine exposes no deterministic fault point between its database and image writes; torn DB/image recovery cannot be established by completed-data SIGKILL.'],
      ['inflight-image-write-cutpoint', 'Real download and replay requests are interrupted with SIGKILL and recovered. A deterministic crash exactly between file fsync and database commit requires an engine fault point not exposed by current RPC.'],
      ['image-cache-byte-ceiling', '2048-file eviction and reload are exercised. The separate 512 MiB ceiling is checked on disk but not saturated by the small deterministic pressure fixture.'],
      ['engine-heap-and-queues', 'Engine exposes no forced-GC heap, allocation, timer, listener, cache-size, queue-depth or pending-task metrics RPC. /proc RSS/CPU/fds/threads are recorded without fabricating these values.'],
      ['full-chapter-repeat50', 'Repeat generate runs 50 real validated script replays with journal cleanup; full novel-to-drawn-chapter generation is exercised once, not 50 times.'],
      ['independent-review', 'Harness implementation only. Parent must arrange fresh-context adversarial and evidence review after approved execution.'],
      ['native-startup-final-budget', 'Three actual native first-pixels baselines are captured. No optimized native variant is compared; first readable chapter and physical presentation are not inferred from shell pixels.'],
    ]
    for (const [name, reason] of limits) evidence.unavailable(name, reason)
    const summary = { ...metadata, phase, mixedIterations, rssGrowthPercentPerHour: soakTrend.growthPerHour(), counts: evidence.counts, limitations: [...evidence.limitations], verdict: evidence.counts.fail ? 'fail' : evidence.counts.unavailable ? 'incomplete' : 'pass', database: join(data, 'library.sqlite'), evidenceRotation: { files: 4, bytesPerFile: 16 * 1024 * 1024, fsyncEveryRow: true } }
    replaceReport(join(config.run, 'report.json'), summary)
    evidence.finish({ report: join(config.run, 'report.json') })
    console.log(JSON.stringify(summary, null, 2))
    process.exitCode = evidence.counts.fail ? 1 : evidence.counts.unavailable ? 2 : 0
  }
}

try {
  if (process.argv[2] === '--inside') await inside(process.argv[3])
  else await outer()
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
