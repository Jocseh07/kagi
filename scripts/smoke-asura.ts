/**
 * Exercises the AsuraScans source against the live API, outside a browser.
 *
 * Run: pnpm exec tsx scripts/smoke-asura.ts
 *
 * Node has no DOMParser, which the source uses only to strip HTML out of
 * descriptions, so a minimal stand-in is installed before importing it.
 */

if (!('DOMParser' in globalThis)) {
  class NodeDOMParser {
    parseFromString(html: string) {
      const text = html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
      return { body: { textContent: text } }
    }
  }
  ;(globalThis as unknown as { DOMParser: unknown }).DOMParser = NodeDOMParser
}

const { AsuraScans } = await import('../src/lib/sources/asurascans/index.ts')

const pass = (m: string) => console.log(`  [32mPASS[0m ${m}`)
const fail = (m: string) => {
  console.log(`  [31mFAIL[0m ${m}`)
  failures++
}
let failures = 0

/** Mirrors the source's own constants; it exports neither. */
const API_URL = 'https://api.asurascans.com/api'
const PER_PAGE = 20

const source = new AsuraScans()
console.log(`\nAsuraScans smoke test — ${source.baseUrl}\n`)

// 1. Popular
const popular = await source.getPopularManga(1)
popular.mangas.length > 0
  ? pass(`popular: ${popular.mangas.length} series, hasNextPage=${popular.hasNextPage}`)
  : fail('popular returned no series')
console.log(`       e.g. ${popular.mangas.slice(0, 3).map((m) => m.title).join(' | ')}`)

// 2. Search
const search = await source.getSearchMangaList(1, 'shadow', source.getFilterList())
search.mangas.length > 0
  ? pass(`search "shadow": ${search.mangas.length} hits — ${search.mangas[0].title}`)
  : fail('search returned nothing')

// 3. Filter data — genres come from /api/genres, not the built-in snapshot
const filterData = await source.fetchFilterData()
filterData.genres.length > 0
  ? pass(`genres: ${filterData.genres.length} — e.g. ${filterData.genres.slice(0, 3).map((g) => g.label).join(', ')}`)
  : fail('no genres')

// 4. Filters applied (status=completed) must narrow results
const filters = source.getFilterList(filterData)
const statusFilter = filters.find((f) => f.type === 'select' && f.name === 'Status')
if (statusFilter && statusFilter.type === 'select') statusFilter.state = 2 // Completed
const filtered = await source.getSearchMangaList(1, '', filters)
pass(`filter status=completed: ${filtered.mangas.length} series`)

// 5. Genre filtering, asserted on identity rather than on a count: every hit
//    must actually carry the genre. That is what proves the label the sheet
//    shows was turned back into the slug the API wants — a wrong slug comes
//    back as a full, unfiltered page and would otherwise read as a pass.
const genreFilters = source.getFilterList(filterData)
const genreGroup = genreFilters.find((f) => f.type === 'group' && f.name === 'Genres')
if (genreGroup?.type === 'group' && genreGroup.state[0]?.type === 'checkbox') {
  const picked = genreGroup.state[0]
  picked.state = true
  const byGenre = await source.getSearchMangaList(1, '', genreFilters)
  const offenders = byGenre.mangas.filter((m) => !m.genre?.includes(picked.name))
  byGenre.mangas.length > 0 && offenders.length === 0
    ? pass(`filter genre=${picked.name}: ${byGenre.mangas.length} series, all carry it`)
    : fail(
        `filter genre=${picked.name}: ${byGenre.mangas.length} series, ${offenders.length} without it`,
      )
} else {
  fail('no genre checkboxes in the filter list')
}

// 6. Pagination must stop at the end, not one page past it. The API omits
//    `has_more` rather than sending false, so the last *full* page is the case
//    that regresses — reachable only when the total is a multiple of the page
//    size, which is why the boundary is computed rather than hardcoded.
const totalRes = await fetch(`${API_URL}/series?offset=0&limit=1`)
const total = ((await totalRes.json()) as { meta?: { total?: number } }).meta?.total ?? 0
const lastPage = Math.max(1, Math.ceil(total / PER_PAGE))
const last = await source.getSearchMangaList(lastPage, '', source.getFilterList())
last.hasNextPage
  ? fail(`pagination: page ${lastPage} of ${total} series claims another page`)
  : pass(`pagination: page ${lastPage} of ${total} series ends the list`)

// 7. Details + chapters
const target = popular.mangas[0]
const update = await source.getMangaUpdate(target, {
  fetchDetails: true,
  fetchChapters: true,
})
update.manga.title ? pass(`details: ${update.manga.title}`) : fail('no title')
console.log(
  `       status=${update.manga.status} author=${update.manga.author ?? '—'} genres=${update.manga.genre?.length ?? 0}`,
)
update.chapters.length > 0
  ? pass(`chapters: ${update.chapters.length} (newest ${update.chapters[0]?.name})`)
  : fail('no chapters')

// 8. "Open in browser" urls must be absolute. `public_url` arrives as a site
//    path, and a relative href resolves against the app's own origin.
const mangaWebUrl = source.getMangaWebUrl(update.manga)
mangaWebUrl.startsWith(source.baseUrl)
  ? pass(`manga web url: ${mangaWebUrl}`)
  : fail(`manga web url is not absolute: ${mangaWebUrl}`)

// 9. Pages
const chapter = update.chapters[update.chapters.length - 1]
const pages = await source.getPageList(update.manga, chapter)
pages.length > 0
  ? pass(`pages for "${chapter.name}": ${pages.length}`)
  : fail('no pages')
console.log(`       first: ${pages[0]?.imageUrl}`)

const chapterWebUrl = source.getChapterWebUrl(update.manga, chapter)
chapterWebUrl.startsWith(source.baseUrl)
  ? pass(`chapter web url: ${chapterWebUrl}`)
  : fail(`chapter web url is not absolute: ${chapterWebUrl}`)

// 10. Can the page image bytes actually be read cross-origin?
const imgUrl = pages[0].imageUrl
const head = await fetch(imgUrl, { headers: { Origin: 'https://localhost:5173' } })
const acao = head.headers.get('access-control-allow-origin')
console.log(
  `\n  image CDN: HTTP ${head.status}, access-control-allow-origin=${acao ?? 'ABSENT'}`,
)
console.log(
  acao
    ? '  [32m→ downloads possible from a browser[0m'
    : '  [33m→ display works; byte reads (download/descramble) blocked in-browser[0m',
)

console.log(
  failures === 0
    ? '\n[32mAll source calls succeeded.[0m\n'
    : `\n[31m${failures} check(s) failed.[0m\n`,
)
process.exit(failures === 0 ? 0 : 1)
