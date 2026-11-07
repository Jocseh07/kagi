import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const PROJECT_ROOT = resolve(import.meta.dir, '../..')

export async function prepareRune(): Promise<string> {
  const manifest = await Bun.file(join(PROJECT_ROOT, 'rune/Cargo.toml')).text()
  const revision = /^rune = \{[^\n]*rev = "([a-f0-9]{40})"/m.exec(manifest)?.[1]
  if (!revision) throw new Error('The native Rune dependency must pin a full commit SHA.')
  const patch = join(PROJECT_ROOT, 'rune/patches/ae8dfeb-runtime-fonts.patch')
  const patchBytes = new Uint8Array(await Bun.file(patch).arrayBuffer())
  const patchHash = createHash('sha256').update(patchBytes).digest('hex')
  const destination = join(PROJECT_ROOT, '.tmp/rune-upstream')
  const marker = join(destination, '.kagi-rune-source.json')
  if (await Bun.file(marker).exists()) {
    const saved: unknown = await Bun.file(marker).json()
    if (saved && typeof saved === 'object' && 'revision' in saved && saved.revision === revision && 'patchHash' in saved && saved.patchHash === patchHash) return destination
  }
  await mkdir(join(PROJECT_ROOT, '.tmp'), { recursive: true })
  const temporary = await mkdtemp(join(PROJECT_ROOT, '.tmp/rune-source-'))
  const checkoutRoot = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'git/checkouts')
  let cached: string | undefined
  for (const entry of await readdir(checkoutRoot).catch(() => [] as string[])) {
    if (!entry.startsWith('rune-')) continue
    const candidate = join(checkoutRoot, entry, revision.slice(0, 7))
    if (await Bun.file(join(candidate, '.cargo-ok')).exists()) { cached = candidate; break }
  }
  if (cached) await cp(cached, temporary, { recursive: true, force: false })
  else {
    const response = await fetch(`https://codeload.github.com/anomalyco/rune/tar.gz/${revision}`)
    if (!response.ok) throw new Error(`Rune source download failed (${response.status}).`)
    const archive = join(PROJECT_ROOT, '.tmp', `rune-${revision}.tar.gz`)
    await Bun.write(archive, response)
    const unpack = Bun.spawn(['tar', '-xzf', archive, '--strip-components=1', '-C', temporary], { stdout: 'inherit', stderr: 'inherit' })
    if (await unpack.exited !== 0) throw new Error('Could not unpack the pinned Rune source.')
  }
  const apply = Bun.spawn(['patch', '-p1', '--forward', '--batch', '-i', patch], { cwd: temporary, stdout: 'inherit', stderr: 'inherit' })
  if (await apply.exited !== 0) throw new Error('The native font patch does not apply to the pinned Rune revision.')
  await writeFile(join(temporary, '.kagi-rune-source.json'), JSON.stringify({ revision, patchHash }) + '\n')
  try {
    const existing = await Bun.file(join(destination, 'Cargo.toml')).exists()
    if (existing) {
      if (!await Bun.file(marker).exists()) throw new Error('The Rune source cache has no ownership marker. Move it aside before rebuilding.')
      await rename(destination, `${destination}-${Date.now()}`)
    }
    await rename(temporary, destination)
  } catch (error) {
    throw new Error(`Could not install the prepared Rune source: ${error instanceof Error ? error.message : String(error)}`)
  }
  return destination
}

if (import.meta.main) await prepareRune()
