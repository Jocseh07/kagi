import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import type { BunPlugin } from 'bun'
import aliases from './aliases.json'
import { nativeStorageModuleMap } from './adapters/storage-modules'

export const ROOT = resolve(import.meta.dir, '../..')
export const ENGINE_OUTPUT = join(ROOT, 'rune/engine/dist')

function canonical(path: string): string | undefined {
  const candidates = [path, ...(extname(path) === '.js' ? [path.slice(0, -3) + '.ts', path.slice(0, -3) + '.tsx'] : []), `${path}.ts`, `${path}.tsx`, join(path, 'index.ts'), join(path, 'index.tsx')]
  return candidates.find((candidate) => existsSync(candidate) && extname(candidate) !== '')
}

export const nativePlugin: BunPlugin = {
  name: 'kagi-native-platforms',
  setup(build) {
    const mappings = new Map(Object.entries({ ...aliases, ...nativeStorageModuleMap }).map(([source, target]) => [resolve(ROOT, source), resolve(ROOT, target)]))
    for (const path of mappings.values()) if (!existsSync(path)) throw new Error(`The native adapter is missing: ${path}`)
    build.onResolve({ filter: /^(@\/|\.{1,2}\/)/ }, (args) => {
      const absolute = args.path.startsWith('@/') ? resolve(ROOT, 'src', args.path.slice(2)) : resolve(dirname(args.importer), args.path)
      const source = canonical(absolute)
      if (!source) return undefined
      const target = mappings.get(source)
      return target ? { path: target } : args.path.startsWith('@/') ? { path: source } : undefined
    })
  },
}

export async function bundleEngine(entry = join(ROOT, 'rune/engine/main.ts'), outdir = ENGINE_OUTPUT): Promise<string> {
  await mkdir(outdir, { recursive: true })
  const built = await Bun.build({
    entrypoints: [entry], target: 'bun', format: 'esm', outdir,
    plugins: [nativePlugin], sourcemap: 'external',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  })
  if (!built.success) {
    for (const log of built.logs) console.error(log)
    throw new Error('The native engine could not be bundled.')
  }
  const output = built.outputs.find((artifact) => artifact.kind === 'entry-point')
  if (!output) throw new Error('The native engine bundle has no entry point.')
  return output.path
}

if (import.meta.main) console.log(await bundleEngine())
