/**
 * Prints what a Mihon backup would import, without a database.
 *
 * The mapping is the part of the importer that cannot be reasoned about from
 * the extensions' source alone — Mihon's url shapes are only knowable from a
 * real export — so this runs the *same* parser and mapper the app uses against
 * a real file and reports the result.
 *
 *   pnpm tsx scripts/mihon-backup-report.ts ~/Downloads/app.mihon_….tachibk
 */

import { readFileSync } from 'node:fs'

import { parseMihonBackup } from '../src/lib/backup/mihon'
import { planFromBackup } from '../src/lib/backup/mihon-plan'

const path = process.argv[2]
if (!path) {
  console.error('usage: mihon-backup-report.ts <file.tachibk>')
  process.exit(1)
}

const backup = await parseMihonBackup(new Uint8Array(readFileSync(path)))
const plan = planFromBackup(backup)

console.log(`file          ${path}`)
console.log(`series        ${plan.totalSeries}`)
console.log(`chapters      ${plan.totalChapters}`)
console.log(`categories    ${plan.categories.length ? plan.categories.join(', ') : '(none)'}`)

console.log('\nwill import')
for (const source of plan.sources) {
  console.log(
    `  ${source.sourceName.padEnd(14)} ${String(source.series).padStart(3)} series` +
      ` (${source.favorites} in library)` +
      ` ${String(source.chapters).padStart(5)} chapters` +
      ` ${String(source.readChapters).padStart(5)} read` +
      (source.skippedChapters ? `  ${source.skippedChapters} chapters unmapped` : ''),
  )
}

console.log('\nwill skip')
const bySource = new Map<string, typeof plan.skipped>()
for (const entry of plan.skipped) {
  const list = bySource.get(entry.sourceName)
  if (list) list.push(entry)
  else bySource.set(entry.sourceName, [entry])
}
for (const [name, entries] of bySource) {
  const chapters = entries.reduce((n, e) => n + e.chapters, 0)
  const read = entries.reduce((n, e) => n + e.readChapters, 0)
  console.log(`  ${name} — ${entries.length} series, ${chapters} chapters, ${read} read`)
  for (const entry of entries) {
    console.log(`      ${entry.title} (${entry.chapters} chapters, ${entry.reason})`)
  }
}

console.log('\nmapped url samples')
for (const source of plan.sources) {
  for (const entry of plan.entries
    .filter((e) => e.sourceId === source.sourceId)
    .slice(0, 2)) {
    console.log(`  ${entry.sourceId}  ${entry.url}`)
    for (const chapter of entry.chapters.slice(0, 2)) {
      console.log(`      ${chapter.url}  ${JSON.stringify(chapter.name)}`)
    }
  }
}

const withHistory = plan.entries.filter((e) => e.history.size > 0)
console.log(
  `\nhistory       ${withHistory.reduce((n, e) => n + e.history.size, 0)} entries across ${withHistory.length} series`,
)
console.log(
  `unmapped ch   ${plan.entries.reduce((n, e) => n + e.skippedChapters, 0)}`,
)
