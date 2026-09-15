/**
 * Exercises the Mangadot source against the live API, outside a browser.
 *
 * Run: pnpm exec tsx scripts/smoke-mangadot.ts
 *
 * No DOMParser stand-in is needed here — unlike Asura, Mangadot sends plain
 * text descriptions rather than HTML fragments, so the source never parses any.
 *
 * Node ignores CORS, which is the whole reason this script can talk to the site
 * directly while the browser build has to go through the dev proxy. The last
 * check reports that gap rather than papering over it.
 */

const { Mangadot } = await import('../src/lib/sources/mangadot/index.ts')

/** Mangadot's group id for Asura Scans, used only to pick a test series. */
const ASURA_GROUP_ID = '17425'

const pass = (m: string) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`)
const fail = (m: string) => {
  console.log(`  \x1b[31mFAIL\x1b[0m ${m}`)
  failures++
}
let failures = 0

/** Mirrors the source's own constants; it exports neither. */
const API_URL = 'https://mangadot.net/api'
const PER_PAGE = 24

const source = new Mangadot()
console.log(`\nMangadot smoke test — ${source.baseUrl}\n`)

// 1. Popular
const popular = await source.getPopularManga(1)
popular.mangas.length > 0
  ? pass(`popular: ${popular.mangas.length} series, hasNextPage=${popular.hasNextPage}`)
  : fail('popular returned no series')
console.log(`       e.g. ${popular.mangas.slice(0, 3).map((m) => m.title).join(' | ')}`)

// 2. Latest — a different sort must not return an identical first page.
const latest = await source.getLatestUpdates(1)
latest.mangas.length > 0 && latest.mangas[0]?.title !== popular.mangas[0]?.title
  ? pass(`latest: ${latest.mangas.length} series — ${latest.mangas[0].title}`)
  : fail('latest returned nothing, or the same ordering as popular')

// 3. Search
const search = await source.getSearchMangaList(1, 'solo', source.getFilterList())
search.mangas.length > 0
  ? pass(`search "solo": ${search.mangas.length} hits — ${search.mangas[0].title}`)
  : fail('search returned nothing')

// 4. Filter data — genres come from the search facets, not the snapshot
const filterData = await source.fetchFilterData()
filterData.genres.length > 0
  ? pass(`genres: ${filterData.genres.length} — e.g. ${filterData.genres.slice(0, 3).join(', ')}`)
  : fail('no genres')

// 5. Status filtering. The API matches this value case-sensitively and ignores
//    anything it does not recognise, so a wrong casing returns a full,
//    unfiltered page — indistinguishable from success on a count alone.
const statusFilters = source.getFilterList(filterData)
const statusFilter = statusFilters.find(
  (f) => f.type === 'select' && f.name === 'Status',
)
if (statusFilter?.type === 'select') {
  statusFilter.state = 2 // Completed
  const filtered = await source.getSearchMangaList(1, '', statusFilters)
  const offenders = filtered.mangas.filter((m) => m.status !== 'completed')
  filtered.mangas.length > 0 && offenders.length === 0
    ? pass(`filter status=Completed: ${filtered.mangas.length} series, all completed`)
    : fail(
        `filter status=Completed: ${filtered.mangas.length} series, ${offenders.length} not completed`,
      )
} else {
  fail('no status filter in the filter list')
}

// 6. Genre filtering, asserted on identity rather than on a count: every hit
//    must actually carry the genre, which is what proves the facet spelling
//    survived the round trip into the `genres` parameter.
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

// 7. Pagination must stop at the end, not one page past it.
const totalRes = await fetch(`${API_URL}/search?page=1&limit=${PER_PAGE}`)
const total =
  ((await totalRes.json()) as { pagination?: { total_pages?: number } }).pagination
    ?.total_pages ?? 1
const last = await source.getSearchMangaList(total, '', source.getFilterList())
last.hasNextPage
  ? fail(`pagination: page ${total} of ${total} claims another page`)
  : pass(`pagination: page ${total} of ${total} ends the list`)

// 8. Details + chapters
const target = search.mangas[0]
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

// 9. Author/artist survive the double JSON encoding the API applies to them.
update.manga.author && !update.manga.author.startsWith('[')
  ? pass(`author decoded: ${update.manga.author}`)
  : fail(`author not decoded: ${update.manga.author ?? 'missing'}`)

// 10. Chapter dates must not collapse to the epoch. The API's timestamps use a
//     space instead of the `T` that Date.parse expects, so this is the check
//     that catches the normalisation being dropped.
const dated = update.chapters.filter((c) => c.dateUpload && c.dateUpload > 0)
dated.length === update.chapters.length
  ? pass(`chapter dates parsed: newest ${new Date(dated[0].dateUpload!).toISOString()}`)
  : fail(`${update.chapters.length - dated.length} chapters have no usable date`)

// 11. Scanlator tagging — what the chapter filter's group picker is built from.
//     Every chapter must name its group, and a series Asura uploads to must
//     come back with several groups including Asura, since a list that reports
//     one group (or none) gives the picker nothing to offer.
//
//     The series is taken from Asura's own upload feed rather than from the
//     search results above: most of the catalogue has no Asura chapters at all,
//     and a title picked blindly would turn this into a check that passes by
//     finding nothing.
const feedRes = await fetch(`${API_URL}/groups/${ASURA_GROUP_ID}`)
const feed = (await feedRes.json()) as {
  recent_uploads?: { manga_id: number; manga_title: string }[]
}
const asuraSeries = feed.recent_uploads?.[0]

if (!asuraSeries) {
  fail('group feed: Asura Scans has no recent uploads to test against')
} else {
  const shared = await source.getMangaUpdate(
    {
      ...target,
      url: `/series/${asuraSeries.manga_id}`,
      memo: { id: asuraSeries.manga_id },
    },
    { fetchDetails: false, fetchChapters: true },
  )

  const groups = new Map<string, number>()
  for (const chapter of shared.chapters) {
    if (chapter.scanlator) {
      groups.set(chapter.scanlator, (groups.get(chapter.scanlator) ?? 0) + 1)
    }
  }

  // Scraped chapters genuinely have no group — the API sends `group_name:
  // null` for them — and the filter files those under "Unknown group". What
  // must not happen is a *user upload* losing its group on the way through,
  // which would put a real group's chapters into that bucket.
  const untagged = shared.chapters.filter((c) => !c.scanlator)
  const lostGroup = untagged.filter((c) => c.memo?.source !== 'scraper')
  lostGroup.length === 0
    ? pass(
        `group attribution: ${shared.chapters.length - untagged.length} tagged, ` +
          `${untagged.length} unattributed and all scraped`,
      )
    : fail(`${lostGroup.length} uploaded chapters lost their group`)

  const asuraCount = groups.get('Asura Scans') ?? 0
  groups.size > 1 && asuraCount > 0
    ? pass(
        `groups on "${asuraSeries.manga_title}": ${groups.size} — ` +
          `Asura Scans ${asuraCount}, ` +
          `${[...groups].filter(([n]) => n !== 'Asura Scans').slice(0, 2).map(([n, c]) => `${n} ${c}`).join(', ')}`,
      )
    : fail(
        `groups on "${asuraSeries.manga_title}": ${groups.size} distinct, Asura Scans ${asuraCount}`,
      )
}

// 12. Pages
const chapter = update.chapters[update.chapters.length - 1]
const pages = await source.getPageList(update.manga, chapter)
pages.length > 0
  ? pass(`pages for "${chapter.name}": ${pages.length}`)
  : fail('no pages')
console.log(`       first: ${pages[0]?.imageUrl}`)

// 13. The reader's round trip. It never sees the objects above: it rebuilds a
//     series and a chapter from the two route params, which the app derives as
//     the trailing segment of each url. Anything the source needs that does not
//     survive that trip is a chapter that reads fine from the list and fails on
//     reload — which is exactly what a `/manga/<id>` identity caused.
const routeSlug = update.manga.url.split('/').pop()!
const routeKey = chapter.url.split('/').pop()!
const rebuiltManga = {
  url: `/series/${routeSlug}`,
  title: routeSlug,
  status: 'unknown' as const,
  initialized: false,
  memo: { slug: routeSlug },
}
const rebuiltChapter = {
  url: `/series/${routeSlug}/chapter/${routeKey}`,
  name: `Chapter ${routeKey}`,
  chapterNumber: 0,
  memo: { mangaSlug: routeSlug },
}
try {
  const reread = await source.getPageList(rebuiltManga, rebuiltChapter)
  reread.length === pages.length && reread[0]?.imageUrl === pages[0]?.imageUrl
    ? pass(`route round trip (${routeSlug} / ${routeKey}): same ${reread.length} pages`)
    : fail(
        `route round trip: ${reread.length} pages, expected ${pages.length} and the same first image`,
      )
} catch (error) {
  fail(`route round trip: ${(error as Error).message}`)
}

// 14. "Open in browser" urls must be absolute and point at the site, not at
//     the proxy prefix the source fetches through.
const mangaWebUrl = source.getMangaWebUrl(update.manga)
mangaWebUrl.startsWith(source.baseUrl)
  ? pass(`manga web url: ${mangaWebUrl}`)
  : fail(`manga web url is not absolute: ${mangaWebUrl}`)

const chapterWebUrl = source.getChapterWebUrl(update.manga, chapter)
chapterWebUrl.startsWith(source.baseUrl)
  ? pass(`chapter web url: ${chapterWebUrl}`)
  : fail(`chapter web url is not absolute: ${chapterWebUrl}`)

// 15. Can the page image bytes actually be read cross-origin?
const head = await fetch(pages[0].imageUrl, {
  headers: { Origin: 'https://localhost:5173' },
})
const acao = head.headers.get('access-control-allow-origin')
console.log(
  `\n  image host: HTTP ${head.status}, access-control-allow-origin=${acao ?? 'ABSENT'}`,
)
console.log(
  acao
    ? '  \x1b[32m→ downloads possible from a browser\x1b[0m'
    : '  \x1b[33m→ no CORS: the browser build must go through the /mangadot proxy\x1b[0m',
)

console.log(
  failures === 0
    ? '\n\x1b[32mAll source calls succeeded.\x1b[0m\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
)
process.exit(failures === 0 ? 0 : 1)
