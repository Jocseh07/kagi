import { AsuraScans } from './asurascans'
import { Comick } from './comick'
import { FenrirRealm } from './fenrirealm'
import { FlameComics } from './flamecomics'
import { LocalSource } from './local'
import { LocalNovelSource } from './local-novel'
import { MangaDex } from './mangadex'
import { Mangakakalot } from './mangakakalot'
import { MangaKatana } from './mangakatana'
import { MangaPlus } from './mangaplus'
import { Mangadot } from './mangadot'
import { NovelFull } from './novelfull'
import { NovelMtl } from './novelmtl'
import { ThunderScans } from './thunderscans'
import { Toonily } from './toonily'
import { Webnovel } from './webnovel'
import { Webtoons } from './webtoons'
import { WeebCentral } from './weebcentral'
import { WuxiaWorld } from './wuxiaworld'
import { sourceCatalog } from './catalog'
import { kindOf } from './types'
import type { ContentKind, Source } from './types'

const sources = new Map<string, Source>()

function register(source: Source) {
  sources.set(source.id, source)
}

register(new AsuraScans())
register(new Mangadot())
register(new ThunderScans())
register(new WeebCentral())
register(new FlameComics())
register(new MangaKatana())
register(new Mangakakalot())
register(new MangaDex())
register(new Comick())
register(new Toonily())
register(new Webtoons())
register(new MangaPlus())
register(new NovelFull())
register(new FenrirRealm())
register(new Webnovel())
register(new NovelMtl())
register(new WuxiaWorld())
register(new LocalSource())
register(new LocalNovelSource())

assertCatalogMatches()

/**
 * The catalog in `catalog.ts` restates each source's id, name and content kind
 * so that callers who only need those facts do not have to construct seven
 * sources — two of which pull in a ZIP decoder — to read them.
 *
 * That duplication is only safe if it cannot drift, so it is checked here: this
 * module is the one place both halves are already loaded. A novel source the
 * catalog thinks is a comic would open in the wrong reader, which is a quiet
 * enough failure to be worth throwing over.
 */
function assertCatalogMatches(): void {
  const problems: string[] = []
  const listed = new Set(sourceCatalog.map((entry) => entry.id))

  for (const entry of sourceCatalog) {
    const source = sources.get(entry.id)
    if (!source) {
      problems.push(`${entry.id}: in the catalog but not registered`)
      continue
    }
    if (source.name !== entry.name) {
      problems.push(`${entry.id}: name is ${source.name}, catalog says ${entry.name}`)
    }
    if (kindOf(source) !== entry.contentKind) {
      problems.push(
        `${entry.id}: contentKind is ${kindOf(source)}, catalog says ${entry.contentKind}`,
      )
    }
  }

  for (const id of sources.keys()) {
    if (!listed.has(id)) problems.push(`${id}: registered but missing from the catalog`)
  }

  if (problems.length > 0) {
    throw new Error(`Source catalog is out of date:\n  ${problems.join('\n  ')}`)
  }
}

export function getSource(id: string): Source {
  const source = sources.get(id)
  if (!source) throw new Error(`Unknown source: ${id}`)
  return source
}

export function listSources(): Source[] {
  return [...sources.values()]
}

/** Sources of one kind, for a Browse tab that shows comics or novels alone. */
export function listSourcesByKind(kind: ContentKind): Source[] {
  return listSources().filter((source) => kindOf(source) === kind)
}
