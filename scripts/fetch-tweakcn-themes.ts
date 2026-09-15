/**
 * Vendors tweakcn's theme registry into src/lib/theme/presets.json.
 *
 * Run with `npm run themes:sync`. The result is committed: the app is
 * offline-first, so the themes have to be on disk rather than a fetch away,
 * and pinning them means a change upstream is a reviewable diff rather than a
 * surprise repaint.
 *
 * Everything is filtered through the same allowlist the runtime importer uses,
 * so what lands in the JSON is already known to be safe to write into a
 * stylesheet.
 */

import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { sanitizeTokens, hasAnyToken, type ThemePreset } from '../src/lib/theme/tokens.ts'

const REGISTRY_URL = 'https://tweakcn.com/r/themes/registry.json'
const OUT_PATH = fileURLToPath(new URL('../src/lib/theme/presets.json', import.meta.url))

type RegistryItem = {
  name?: string
  title?: string
  description?: string
  cssVars?: { theme?: unknown; light?: unknown; dark?: unknown }
}

function titleCase(name: string): string {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

async function main(): Promise<void> {
  const response = await fetch(REGISTRY_URL)
  if (!response.ok) {
    throw new Error(`${REGISTRY_URL} responded ${response.status}`)
  }

  const registry = (await response.json()) as { items?: RegistryItem[] }
  const items = registry.items ?? []
  if (items.length === 0) throw new Error('registry contained no items')

  const presets: ThemePreset[] = []
  const skipped: string[] = []

  for (const item of items) {
    const id = item.name?.trim()
    if (!id) continue

    const tokens = sanitizeTokens(item.cssVars)
    if (!hasAnyToken(tokens)) {
      skipped.push(id)
      continue
    }

    // tweakcn ships the body letter-spacing as a per-item `css` rule pointing
    // at --tracking-normal. index.css carries that one rule for every theme,
    // so the variable just has to exist.
    for (const mode of ['light', 'dark'] as const) {
      const vars = tokens[mode]
      if (!vars['tracking-normal'] && vars['letter-spacing']) {
        vars['tracking-normal'] = vars['letter-spacing']
      }
    }

    presets.push({
      id,
      title: item.title?.trim() || titleCase(id),
      description: item.description?.trim() || undefined,
      source: 'tweakcn',
      tokens,
    })
  }

  await writeFile(OUT_PATH, `${JSON.stringify(presets, null, 2)}\n`, 'utf8')

  console.log(`wrote ${presets.length} themes to ${OUT_PATH}`)
  if (skipped.length > 0) {
    console.warn(`skipped ${skipped.length} with no usable tokens: ${skipped.join(', ')}`)
  }
}

await main()
