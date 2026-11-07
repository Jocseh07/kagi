import { cp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { FONTS } from '../../src/lib/fonts/model'
import { PROJECT_ROOT } from './prepare-rune'

export async function prepareAssets(destination = join(PROJECT_ROOT, '.tmp/rune-assets')): Promise<string> {
  const families = [...FONTS, { id: 'comic-neue', name: 'Comic Neue', stack: "'Comic Neue', sans-serif" }]
  const manifest: { id: string; name: string; files: string[]; license: string }[] = []
  await mkdir(join(destination, 'fonts'), { recursive: true })
  for (const font of families) {
    const variable = join(PROJECT_ROOT, 'node_modules/@fontsource-variable', font.id)
    const fixed = join(PROJECT_ROOT, 'node_modules/@fontsource', font.id)
    const source = existsSync(variable) ? variable : existsSync(fixed) ? fixed : undefined
    if (!source) throw new Error(`The installed font package is missing: ${font.name}. Run the root dependency install.`)
    const all = await readdir(join(source, 'files'))
    const selected = all.filter((name) => name.endsWith('.woff2') && name.includes('-latin-') && !name.includes('-latin-ext-')).sort()
    if (!selected.length) throw new Error(`The font package has no Latin WOFF2 files: ${font.name}.`)
    const output = join(destination, 'fonts')
    for (const name of selected) await cp(join(source, 'files', name), join(output, name))
    const license = join(source, 'LICENSE')
    if (!existsSync(license)) throw new Error(`The font license is missing: ${font.name}.`)
    const licenseDirectory = join(output, 'licenses', font.id)
    await mkdir(licenseDirectory, { recursive: true })
    await cp(license, join(licenseDirectory, 'LICENSE'))
    manifest.push({ id: font.id, name: font.name, files: selected, license: `licenses/${font.id}/LICENSE` })
  }
  await writeFile(join(destination, 'fonts/catalog.json'), JSON.stringify({ schemaVersion: 1, families: manifest }, null, 2) + '\n')
  await cp(join(PROJECT_ROOT, 'public/favicon.svg'), join(destination, 'icon.svg'))
  return destination
}

if (import.meta.main) console.log(await prepareAssets())
