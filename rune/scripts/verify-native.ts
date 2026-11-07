import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { Evidence, ProcessGuard, Trend, delay, exited, killTree } from './verify-runtime'
import type { ReadingTarget } from './verify-scenarios'

interface Element { key?: string; text?: string; label?: string; [key: string]: unknown }
function elements(value: unknown, result: Element[] = []): Element[] {
  if (Array.isArray(value)) for (const item of value) elements(item, result)
  else if (value && typeof value === 'object') {
    const entry = value as Element
    if (typeof entry.key === 'string' || typeof entry.text === 'string') result.push(entry)
    for (const [key, item] of Object.entries(entry)) if (key !== 'text' && key !== 'label') elements(item, result)
  }
  assert(result.length < 100_000, 'Native tree exceeds fixture bound')
  return result
}
export interface NativeOptions { ui?: string; engine: string; data: string; root: string; idleSeconds: number; ticks: number; pageSize: number }
export async function nativeVerification(options: NativeOptions, target: ReadingTarget, guard: ProcessGuard, evidence: Evidence): Promise<void> {
  if (!options.ui) {
    evidence.unavailable('native-tooling', 'No built native executable. Pass --ui /absolute/path/to/kagi-rune. Engine RPC is not native rendering evidence.')
    evidence.unavailable('native-idle', 'No native executable; engine-only idle cannot establish UI plus engine idle CPU.')
    return
  }
  const ui = options.ui
  const nativeGuard = new ProcessGuard(evidence, guard.port, { ...guard.env, KAGI_ENGINE: options.engine, KAGI_BUN: process.execPath })
  try {
    const startup: number[] = []
    for (let run = 0; run < 3; run++) await evidence.case('native-first-pixels-baseline', 'Real Rune emits its flushed first offscreen GPU-readback marker', async () => {
      const start = performance.now()
      const child = nativeGuard.start([ui, '--first-pixels', '--frames', '1', '--data-dir', options.data], 'native-startup')
      const output = createInterface({ input: child.stdout })
      let firstPixels: number | undefined
      output.on('line', (line) => { if (line.startsWith('rune-first-pixels ')) firstPixels ??= performance.now() - start })
      child.stdin.end()
      const timer = setTimeout(() => killTree(child, 'SIGKILL'), 60_000)
      try { await exited(child) } finally { clearTimeout(timer); output.close() }
      assert.equal(child.exitCode, 0)
      assert(firstPixels !== undefined, 'Rune did not emit its first-pixels marker')
      startup.push(firstPixels)
      return { run: run + 1, firstPixelsMs: firstPixels, definition: 'Launch to GPU readback, not physical display or first readable chapter' }
    })
    if (startup.length === 3) {
      const p95 = Math.max(...startup), spread = p95 - Math.min(...startup)
      evidence.emit('baseline-budget', { name: 'native-first-pixels', samplesMs: startup, p95Ms: p95, spreadMs: spread, budgetMs: p95 + Math.max(p95 * 0.1, spread) })
    }
    await evidence.case('native-persisted-home', 'Actual Rune tree renders the persisted comic title after real engine RPC arrives', async () => {
      for (const frames of [20_000, 40_000, 80_000]) {
        const tree = join(options.root, `native-home-${frames}.json`)
        const image = join(options.root, `native-home-${frames}.png`)
        const child = nativeGuard.start([ui, '--tree', tree, '--snap', image, '--frames', String(frames), '--size', '1200x900', '--data-dir', options.data], 'native-home')
        child.stdout.resume(); child.stdin.end()
        const timer = setTimeout(() => killTree(child, 'SIGKILL'), 120_000)
        try { await exited(child) } finally { clearTimeout(timer) }
        assert.equal(child.exitCode, 0, 'Native render failed; inspect process-diagnostic evidence')
        const model: unknown = JSON.parse(await readFile(tree, 'utf8'))
        const nodes = elements(model)
        if (nodes.some((node) => node.text === target.title || node.label === target.title)) return { tree, image, frames, title: target.title, readiness: 'Observed persisted data, not assumed from virtual time' }
      }
      throw new Error('Native engine content never appeared within the bounded adaptive frame runs')
    })
    evidence.unavailable('native-input-parity', 'Rune CLI input is scheduled on virtual time with no readiness barrier. Parent observed 240 frames in 0.03s and 20000 frames in 1.2s. Unpaced clicks are not native action proof; no scripted click pass is synthesized.')
    evidence.unavailable('native-interaction-wall-latency', 'Rune has no inspector socket or app completion timestamps for input-to-visible p95 <=50 ms. Engine RPC latency is reported separately.')
    evidence.unavailable('native-scroll-frame-cpu', 'Static native snapshots cannot prove the 16.7 ms scrolling frame CPU budget. A paced native input/frame capture hook is required.')
    evidence.unavailable('native-mixed-soak', 'The seeded 20-minute mix drives real engine/app actions. Rune has no live readiness-aware input hook, so it is not presented as a 20-minute native UI input soak.')
    const display = guard.env.WAYLAND_DISPLAY || guard.env.DISPLAY
    if (!display || options.idleSeconds <= 0) {
      evidence.unavailable('native-idle', !display ? 'A desktop display is required for UI plus engine idle sampling.' : 'Idle disabled by --idle-seconds 0')
      return
    }
    await evidence.case('native-idle', 'UI plus engine CPU below 1% of one core over requested idle interval; postwarmup RSS below 5%/h', async () => {
      const trace = join(options.root, 'native-idle-frames.jsonl')
      const child = nativeGuard.start([ui, '--native', '--trace', trace, '--data-dir', options.data], 'native-idle')
      child.stdout.resume()
      const trend = new Trend()
      const start = performance.now()
      let previous: Map<string, number> | undefined
      let cpu = 0, elapsed = 0
      try {
        await delay(5000)
        const end = performance.now() + options.idleSeconds * 1000
        let lastAt = performance.now()
        while (performance.now() < end) {
          await delay(1000)
          assert(child.exitCode === null && child.signalCode === null, 'Native UI exited during idle')
          try { assert((await stat(trace)).size <= 64 * 1024 * 1024, 'Native trace exceeded its 64 MiB evidence bound') } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
          const at = performance.now()
          const samples = await nativeGuard.samples(options.ticks, options.pageSize)
          assert(samples.some((sample) => sample.role === 'ui') && samples.some((sample) => sample.role === 'engine'), 'UI and engine must both be sampled')
          const current = new Map(samples.map((sample) => [`${sample.pid}:${sample.startTicks}`, sample.cpuSeconds]))
          if (previous) {
            for (const [id, seconds] of current) if (previous.has(id)) cpu += Math.max(0, seconds - previous.get(id)!)
            elapsed += (at - lastAt) / 1000
          }
          const rss = samples.reduce((sum, sample) => sum + sample.rssBytes, 0)
          if (at - start >= 30_000) trend.add((at - start) / 1000, rss)
          evidence.emit('sample', { phase: 'native-idle', elapsedSeconds: (at - start) / 1000, processes: samples, rssBytes: rss })
          previous = current; lastAt = at
        }
        const percent = elapsed ? cpu / elapsed * 100 : null
        assert(percent !== null && percent < 1, `Idle CPU ${percent}% exceeds one-core 1% budget`)
        if (options.idleSeconds < 300) evidence.unavailable('full-idle-duration', `Requested ${options.idleSeconds}s is shorter than required 300s`)
        const growth = trend.growthPerHour()
        if (growth === null) evidence.unavailable('native-idle-rss-slope', 'Fewer than 30 postwarmup samples')
        else assert(growth < 5, `Idle RSS growth ${growth}%/h exceeds 5%/h`)
        return { elapsedSeconds: elapsed, cpuPercentOneCore: percent, rssGrowthPercentPerHour: growth }
      } finally { killTree(child, 'SIGTERM'); await nativeGuard.stop() }
    })
  } finally {
    await nativeGuard.stop()
    guard.violations += nativeGuard.violations
  }
}
