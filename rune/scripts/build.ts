import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, cp, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, statfs, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { bundleEngine } from '../engine/build'
import { prepareAssets } from './fonts'
import { prepareRune, PROJECT_ROOT } from './prepare-rune'

const TARGET = 'x86_64-unknown-linux-gnu'
const PACKAGE = 'kagi-rune-linux-x64'
const DIST = join(PROJECT_ROOT, 'rune/dist')
const REVISION = 'ae8dfeb87cfad081fa87dc38d215ed0d1ba417a7'

async function run(command: string[], cwd = PROJECT_ROOT, capture = false): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdin: 'ignore', stdout: capture ? 'pipe' : 'inherit', stderr: 'inherit', env: { ...process.env, TMPDIR: join(PROJECT_ROOT, '.tmp/rune-build-tmp') } })
  const output = capture ? new Response(child.stdout as ReadableStream<Uint8Array>).text() : Promise.resolve('')
  const [code, text] = await Promise.all([child.exited, output])
  if (code !== 0) throw new Error(`${command[0]} failed with exit code ${code}.`)
  return text
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk)
  return hash.digest('hex')
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY)
  try { await handle.sync() } finally { await handle.close() }
}

async function syncTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) await syncTree(path)
    else {
      const handle = await open(path, 'r')
      try { await handle.sync() } finally { await handle.close() }
    }
  }
  await syncDirectory(root)
}

async function files(root: string): Promise<string[]> {
  const output: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) output.push(...await files(path))
    else if (entry.isFile()) output.push(path)
    else throw new Error(`The package contains a non-regular entry: ${path}`)
  }
  return output.sort()
}

async function copyNotices(source: string, destination: string): Promise<number> {
  let count = 0
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!/^(?:licen[cs]e|copying|copyright|notice|authors)(?:$|[._-])/i.test(entry.name)) continue
    await mkdir(destination, { recursive: true })
    await cp(join(source, entry.name), join(destination, entry.name), { recursive: true, dereference: true })
    count++
  }
  return count
}

type CargoPackage = { name: string; version: string; manifest_path: string; license: string | null; license_file: string | null; source: string | null }

async function licenses(root: string, upstream: string, cargo: { packages: CargoPackage[] }): Promise<void> {
  const destination = join(root, 'licenses')
  await mkdir(destination, { recursive: true })
  await cp(join(PROJECT_ROOT, 'LICENSE'), join(destination, 'Kagi-LICENSE'))
  await cp(join(upstream, 'LICENSE'), join(destination, 'Rune-LICENSE'))
  const inventory: { name: string; version: string; license: unknown; notices: number }[] = []
  const seen = new Set<string>()
  for (const modules of [join(PROJECT_ROOT, 'node_modules'), join(PROJECT_ROOT, 'rune/engine/node_modules')]) {
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue
        const path = join(directory, entry.name)
        if (entry.name.startsWith('@')) { await visit(path); continue }
        const actual = await realpath(path)
        if (seen.has(actual) || !await Bun.file(join(actual, 'package.json')).exists()) continue
        seen.add(actual)
        const pkg = await Bun.file(join(actual, 'package.json')).json() as { name: string; version: string; license?: unknown }
        const notices = await copyNotices(actual, join(destination, 'npm', `${pkg.name.replaceAll('/', '+')}@${pkg.version}`))
        const nested = join(actual, 'node_modules')
        if ((await lstat(nested).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined }))?.isDirectory()) await visit(nested)
        inventory.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? null, notices })
      }
    }
    await visit(modules)
  }
  await writeFile(join(destination, 'npm-packages.json'), JSON.stringify(inventory.sort((a, b) => a.name.localeCompare(b.name)), null, 2) + '\n')
  const rust = []
  for (const pkg of cargo.packages) {
    const directory = dirname(pkg.manifest_path)
    const output = join(destination, 'rust', `${pkg.name}@${pkg.version}`)
    const notices = await copyNotices(directory, output)
    if (pkg.license_file) {
      await mkdir(output, { recursive: true })
      await cp(resolve(directory, pkg.license_file), join(output, basename(pkg.license_file)))
    }
    rust.push({ name: pkg.name, version: pkg.version, license: pkg.license, source: pkg.source, notices })
  }
  await writeFile(join(destination, 'rust-packages.json'), JSON.stringify(rust, null, 2) + '\n')
  const licensePath = join(PROJECT_ROOT, '.tmp/rune-build-inputs', `bun-${Bun.version}-LICENSE.md`)
  const licenseUrl = `https://raw.githubusercontent.com/oven-sh/bun/bun-v${Bun.version}/LICENSE.md`
  if (!await Bun.file(licensePath).exists()) {
    const response = await fetch(licenseUrl, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`Cannot retrieve Bun's distribution license (${response.status}).`)
    await mkdir(dirname(licensePath), { recursive: true })
    const temporary = `${licensePath}.${randomUUID()}.tmp`
    try {
      await Bun.write(temporary, response)
      await rename(temporary, licensePath)
    } finally { await rm(temporary, { force: true }) }
  }
  await cp(licensePath, join(destination, 'Bun-LICENSE.md'))
  await writeFile(join(destination, 'Bun-NOTICE'), `Bun ${Bun.version}\n${licenseUrl}\nThe unmodified upstream LICENSE.md lists Bun's linked libraries and their licenses.\n`)
}

async function dependencies(paths: string[]): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {}
  for (const path of paths) {
    const output = await run(['ldd', path], PROJECT_ROOT, true)
    if (/not found/.test(output)) throw new Error(`A native dependency is missing for ${basename(path)}:\n${output}`)
    result[basename(path)] = output.trim().split('\n').map((line) => line.trim().replace(/\s*\(0x[0-9a-f]+\)/g, '').replace(/=>\s+\/\S+/g, '=> system'))
  }
  return result
}

async function main(): Promise<void> {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Build the portable package on Linux x64 with glibc. Cross-compilation is not supported.')
  const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } }
  if (!report.header.glibcVersionRuntime) throw new Error('The Linux package requires glibc, not musl.')
  const manifest = await Bun.file(join(PROJECT_ROOT, 'rune/Cargo.toml')).text()
  if (!manifest.includes(`rev = "${REVISION}"`)) throw new Error('The package builder requires the approved pinned Rune revision.')
  const enginePackage = await Bun.file(join(PROJECT_ROOT, 'rune/engine/package.json')).json() as { dependencies: Record<string, string> }
  if (enginePackage.dependencies['@napi-rs/canvas'] !== '1.0.13' || enginePackage.dependencies.linkedom !== '0.18.14') throw new Error('The approved native engine dependencies must remain pinned.')
  await mkdir(DIST, { recursive: true })
  await mkdir(join(PROJECT_ROOT, '.tmp/rune-build-tmp'), { recursive: true })
  for (const directory of [DIST, join(PROJECT_ROOT, '.tmp')]) {
    if ((await statfs(directory)).type === 0x01021994) throw new Error(`Build output must not use RAM-backed tmpfs: ${directory}`)
  }
  const lock = await open(join(DIST, '.build.lock'), 'wx')
  let stage: string | undefined
  let pointer: string | undefined
  try {
    const upstream = await prepareRune()
    stage = await mkdtemp(join(DIST, '.staging-'))
    const root = join(stage, PACKAGE)
    const bin = join(root, 'bin')
    const assets = join(root, 'assets')
    await mkdir(bin, { recursive: true })
    await prepareAssets(assets)
    const bundle = await bundleEngine(undefined, join(stage, 'engine-bundle'))
    await run([process.execPath, 'build', bundle, '--compile', '--target=bun-linux-x64-baseline', '--external=*.node', '--outfile', join(bin, 'kagi-engine')])
    const canvas = join(PROJECT_ROOT, 'rune/engine/node_modules/@napi-rs/canvas-linux-x64-gnu')
    const native = await Bun.file(join(canvas, 'package.json')).json() as { version: string }
    if (native.version !== '1.0.13') throw new Error('The installed canvas binary must be version 1.0.13.')
    await mkdir(join(root, 'lib'), { recursive: true })
    await cp(join(canvas, 'skia.linux-x64-gnu.node'), join(root, 'lib/skia.linux-x64-gnu.node'))
    await cp(join(canvas, 'sbom.cdx.json'), join(root, 'lib/canvas-sbom.cdx.json'))
    await run(['cargo', 'build', '--locked', '--offline', '--release', '--target', TARGET, '--target-dir', join(PROJECT_ROOT, 'rune/target'), '--manifest-path', 'rune/Cargo.toml'])
    await cp(join(PROJECT_ROOT, 'rune/target', TARGET, 'release/kagi-rune'), join(bin, 'kagi-rune'))
    const cargo = JSON.parse(await run(['cargo', 'metadata', '--locked', '--offline', '--format-version=1', '--filter-platform', TARGET, '--manifest-path', 'rune/Cargo.toml'], PROJECT_ROOT, true)) as { packages: CargoPackage[] }
    await licenses(root, upstream, cargo)
    await cp(join(PROJECT_ROOT, 'docs/native.md'), join(root, 'README.md'))
    await writeFile(join(root, 'kagi-rune'), `#!/bin/sh\nset -eu\ncase "$0" in\n  /*) launcher=$0 ;;\n  */*) launcher=$PWD/$0 ;;\n  *) launcher=$(command -v -- "$0") ;;\nesac\nlauncher=$(readlink -f -- "$launcher")\nbase=$(CDPATH= cd -- "$(dirname -- "$launcher")" && pwd -P)\nexport KAGI_ENGINE="$base/bin/kagi-engine"\nexport KAGI_ASSETS_DIR="$base/assets"\nexport NAPI_RS_NATIVE_LIBRARY_PATH="$base/lib/skia.linux-x64-gnu.node"\nexec "$base/bin/kagi-rune" "$@"\n`)
    await writeFile(join(root, 'kagi-rune.desktop'), '[Desktop Entry]\nType=Application\nName=Kagi Rune\nComment=Read manga and novels\nExec=kagi-rune\nIcon=kagi-rune\nTerminal=false\nCategories=Office;Viewer;\nStartupNotify=true\n')
    for (const path of [join(root, 'kagi-rune'), join(bin, 'kagi-rune'), join(bin, 'kagi-engine')]) await chmod(path, 0o755)
    const sharedLibraries = await dependencies([join(bin, 'kagi-rune'), join(bin, 'kagi-engine'), join(root, 'lib/skia.linux-x64-gnu.node')])
    const inventory = []
    for (const path of await files(root)) {
      inventory.push({ path: relative(root, path), bytes: (await lstat(path)).size, sha256: await sha256(path) })
    }
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: PACKAGE, schemaVersion: 1, target: TARGET, runeRevision: REVISION, bunVersion: Bun.version, canvasVersion: native.version, glibcBuildVersion: report.header.glibcVersionRuntime, sharedLibraries, files: inventory }, null, 2) + '\n')
    await rm(join(stage, 'engine-bundle'), { recursive: true })
    const archive = join(stage, `${PACKAGE}.tar.gz`)
    await run(['tar', '-czf', archive, '-C', stage, PACKAGE])
    await writeFile(join(stage, 'SHA256SUMS'), `${await sha256(archive)}  ${PACKAGE}.tar.gz\n`)
    await syncTree(stage)
    const id = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID()}`
    const releases = join(DIST, 'packages')
    await mkdir(releases, { recursive: true })
    const release = join(releases, id)
    await rename(stage, release)
    stage = undefined
    await syncDirectory(releases)
    pointer = join(DIST, `.current-${randomUUID()}`)
    await symlink(relative(DIST, release), pointer)
    const current = join(DIST, 'current')
    const previous = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined })
    if (previous && !previous.isSymbolicLink()) throw new Error('rune/dist/current is not a package symlink. Move it aside before publishing a package.')
    await rename(pointer, current)
    pointer = undefined
    await syncDirectory(DIST)
    console.log(`Package: ${join(current, PACKAGE)}\nArchive: ${join(current, `${PACKAGE}.tar.gz`)}\nChecksums: ${join(current, 'SHA256SUMS')}`)
  } finally {
    if (pointer) await rm(pointer, { force: true })
    if (stage) await rm(stage, { recursive: true, force: true })
    await lock.close()
    await rm(join(DIST, '.build.lock'))
  }
}

if (import.meta.main) await main()
