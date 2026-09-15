/**
 * Exercises the Fenrir Realm source against the live API, outside a browser.
 *
 * Run: pnpm exec tsx scripts/smoke-fenrirealm.ts
 *
 * No DOMParser stand-in is needed. The source is pure JSON and does its own
 * decoy stripping with string operations precisely so that it behaves the same
 * here as it does in the browser — which is what makes checks 10 and 11 below
 * worth anything. `sanitizeChapterHtml` still degrades to tag-stripping under
 * Node, so those checks assert on the text rather than on the markup.
 *
 * Node ignores CORS, which is the whole reason this script can talk to the site
 * directly while the browser build has to go through the /fenrirealm proxy. The
 * last check reports that gap rather than papering over it.
 */

const { FenrirRealm } = await import('../src/lib/sources/fenrirealm/index.ts')

/**
 * A long-running paid novel, used only to find the awkward chapters: its early
 * chapters are the older `json` body format and its newest ones are still
 * premium. Both cases are rare enough that picking a series blindly would turn
 * two checks into passes-by-finding-nothing.
 */
const PROBE_SLUG = 'absolute-regression'

/** Mirrors the source's own constants; it exports neither. */
const API = 'https://fenrirealm.com/api/new/v2'
const PER_PAGE = 24

const pass = (m: string) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`)
const fail = (m: string) => {
  console.log(`  \x1b[31mFAIL\x1b[0m ${m}`)
  failures++
}
let failures = 0

const api = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${API}${path}`)
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`)
  return (await res.json()) as T
}

const source = new FenrirRealm()
console.log(`\nFenrir Realm smoke test — ${source.baseUrl}\n`)

// 1. Popular
const popular = await source.getPopularManga(1)
popular.mangas.length > 0
  ? pass(`popular: ${popular.mangas.length} series, hasNextPage=${popular.hasNextPage}`)
  : fail('popular returned no series')
console.log(
  `       e.g. ${popular.mangas.slice(0, 3).map((m) => m.title).join(' | ')}`,
)

// 2. Latest — a different sort must not return an identical first page.
const latest = await source.getLatestUpdates(1)
latest.mangas.length > 0 && latest.mangas[0]?.title !== popular.mangas[0]?.title
  ? pass(`latest: ${latest.mangas.length} series — ${latest.mangas[0].title}`)
  : fail('latest returned nothing, or the same ordering as popular')

// 3. Listing cards must arrive complete. The listing and detail endpoints
//    return the same shape, which is why the source marks them initialized —
//    if that stopped being true, every shelf tile would need a second request.
const card = popular.mangas[0]
card?.thumbnailUrl && card.genre?.length && card.description
  ? pass(`listing cards complete: cover, ${card.genre.length} genres, description`)
  : fail(
      `listing card is thin: cover=${Boolean(card?.thumbnailUrl)} genres=${card?.genre?.length ?? 0} description=${Boolean(card?.description)}`,
    )

// 4. Descriptions are HTML on the wire and plain text in the app.
!card?.description?.includes('<')
  ? pass(`description reduced to text: ${card?.description?.slice(0, 60)}…`)
  : fail('description still carries markup')

// 5. Search
const search = await source.getSearchMangaList(1, 'regression', source.getFilterList())
search.mangas.length > 0
  ? pass(`search "regression": ${search.mangas.length} hits — ${search.mangas[0].title}`)
  : fail('search returned nothing')

// 6. Filter data
const filterData = await source.fetchFilterData()
filterData.genres.length > 0
  ? pass(
      `genres: ${filterData.genres.length} — e.g. ${filterData.genres.slice(0, 3).map((g) => g.name).join(', ')}`,
    )
  : fail('no genres')

// 7. Status filtering, asserted on identity rather than on a count. The API
//    400s on a value it does not recognise, so a wrong spelling fails loudly —
//    but a value it accepts and ignores would not, and only checking every
//    result catches that.
const statusFilters = source.getFilterList(filterData)
const statusFilter = statusFilters.find(
  (f) => f.type === 'select' && f.name === 'Status',
)
if (statusFilter?.type === 'select') {
  statusFilter.state = 2 // Completed
  const filtered = await source.getSearchMangaList(1, '', statusFilters)
  const offenders = filtered.mangas.filter((m) => m.status !== 'completed')
  filtered.mangas.length > 0 && offenders.length === 0
    ? pass(`filter status=completed: ${filtered.mangas.length} series, all completed`)
    : fail(
        `filter status=completed: ${filtered.mangas.length} series, ${offenders.length} not completed`,
      )
} else {
  fail('no status filter in the filter list')
}

// 8. Genre filtering. The filter sheet carries genre *names* and the API takes
//    *ids*, so this is the check that the source's name-to-id mapping survived
//    the trip from the taxonomy into the query.
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

// 9. Pagination must stop at the end, not one page past it.
const meta = await api<{ meta: { last_page: number } }>(
  `/series?page=1&per_page=${PER_PAGE}`,
)
const lastPage = meta.meta.last_page
const last = await source.getSearchMangaList(lastPage, '', source.getFilterList())
last.hasNextPage
  ? fail(`pagination: page ${lastPage} of ${lastPage} claims another page`)
  : pass(`pagination: page ${lastPage} of ${lastPage} ends the list`)

// 10. Details + the whole chapter list, which the API serves in one request.
const target = { ...search.mangas[0], url: `/series/${PROBE_SLUG}`, memo: { slug: PROBE_SLUG } }
const update = await source.getMangaUpdate(target, {
  fetchDetails: true,
  fetchChapters: true,
})
update.manga.title ? pass(`details: ${update.manga.title}`) : fail('no title')
console.log(
  `       status=${update.manga.status} translator=${update.manga.author ?? '—'} genres=${update.manga.genre?.length ?? 0}`,
)
update.chapters.length > 0
  ? pass(
      `chapters: ${update.chapters.length} (${update.chapters[0]?.name} … ${update.chapters[update.chapters.length - 1]?.name})`,
    )
  : fail('no chapters')

// 11. Chapter dates must not collapse to the epoch.
const dated = update.chapters.filter((c) => c.dateUpload && c.dateUpload > 0)
dated.length === update.chapters.length
  ? pass(`chapter dates parsed: oldest ${new Date(dated[0].dateUpload!).toISOString()}`)
  : fail(`${update.chapters.length - dated.length} chapters have no usable date`)

// The two body formats and the paywall, picked off the raw list so each check
// tests the case it names rather than whatever chapter 1 happens to be.
const raw = await api<
  { id: number; locked?: { price?: number; unlocked_at?: string | null } }[]
>(`/series/${PROBE_SLUG}/chapters`)
const free = raw.filter((c) => !((c.locked?.price ?? 0) > 0 && !c.locked?.unlocked_at))
const premium = raw.find((c) => (c.locked?.price ?? 0) > 0 && !c.locked?.unlocked_at)

const bodies = await Promise.all(
  [free[0], free[free.length - 1]].map((c) =>
    api<{ id: number; content_format?: string }>(`/chapters/${c.id}`),
  ),
)
const jsonBody = bodies.find((b) => b.content_format === 'json')
const htmlBody = bodies.find((b) => b.content_format === 'html')

/**
 * The decoy blocks are long unbroken runs of mixed-case hash. Real prose has
 * spaces in it, so a very long run of non-space characters is the tell.
 */
const DECOY_RUN = /\S{40,}/
const INVISIBLE = /[\u00ad\u200b-\u200f\u2060\ufeff]/

const readChapter = async (id: number) => {
  const chapter = update.chapters.find((c) => c.memo?.id === id)
  if (!chapter) throw new Error(`chapter ${id} is missing from the parsed list`)
  return await source.getChapterText(update.manga, chapter)
}

// 12. An HTML chapter, with the anti-scraping furniture removed.
if (htmlBody) {
  const text = await readChapter(htmlBody.id)
  const decoy = DECOY_RUN.exec(text.html)
  const invisible = INVISIBLE.test(text.html)
  text.textLength > 500 && !decoy && !invisible
    ? pass(`html chapter: ${text.textLength} chars, no decoys, no zero-width`)
    : fail(
        `html chapter: ${text.textLength} chars, decoy=${decoy?.[0]?.slice(0, 24) ?? 'none'}, zero-width=${invisible}`,
      )
} else {
  fail('no html-format chapter found to test against')
}

// 13. A TipTap chapter. Older chapters use it and the site still serves them,
//     so the renderer has to keep working; unhandled, it would show the reader
//     a wall of raw JSON.
if (jsonBody) {
  const text = await readChapter(jsonBody.id)
  text.textLength > 500 && !text.html.includes('"type"')
    ? pass(`json chapter: ${text.textLength} chars rendered from TipTap`)
    : fail(`json chapter: ${text.textLength} chars, raw JSON leaked=${text.html.includes('"type"')}`)
} else {
  fail('no json-format chapter found to test against')
}

// 14. A premium chapter must be refused, not shown. The API answers 200 with a
//     two-paragraph teaser, which would otherwise read as a very short chapter.
if (premium) {
  const chapter = update.chapters.find((c) => c.memo?.id === premium.id)!
  try {
    const text = await source.getChapterText(update.manga, chapter)
    fail(`premium chapter returned ${text.textLength} chars instead of refusing`)
  } catch (error) {
    /premium/i.test((error as Error).message)
      ? pass(`premium chapter refused: ${(error as Error).message.slice(0, 60)}…`)
      : fail(`premium chapter failed for the wrong reason: ${(error as Error).message}`)
  }
} else {
  console.log('  \x1b[33mSKIP\x1b[0m no premium chapter on the probe series today')
}

// 15. The reader's round trip. It never sees the objects above: it rebuilds a
//     series and a chapter from the two route params, which the app derives as
//     the trailing segment of each url. Anything the source needs that does not
//     survive that trip is a chapter that reads fine from the list and fails on
//     reload.
const routeSlug = update.manga.url.split('/').pop()!
const sample = update.chapters.find((c) => c.memo?.id === (htmlBody ?? bodies[0]).id)!
const routeKey = sample.url.split('/').pop()!
try {
  const reread = await source.getChapterText(
    {
      url: `/series/${routeSlug}`,
      title: routeSlug,
      status: 'unknown' as const,
      initialized: false,
      memo: { slug: routeSlug },
    },
    {
      url: `/series/${routeSlug}/chapter/${routeKey}`,
      name: `Chapter ${routeKey}`,
      chapterNumber: 0,
    },
  )
  reread.textLength > 0
    ? pass(`route round trip (${routeSlug} / ${routeKey}): ${reread.textLength} chars`)
    : fail('route round trip returned an empty chapter')
} catch (error) {
  fail(`route round trip: ${(error as Error).message}`)
}

// 16. "Open in browser" urls must be absolute and point at the site, not at
//     the proxy prefix the source fetches through.
const mangaWebUrl = source.getMangaWebUrl(update.manga)
mangaWebUrl.startsWith(source.baseUrl)
  ? pass(`manga web url: ${mangaWebUrl}`)
  : fail(`manga web url is not absolute: ${mangaWebUrl}`)

const chapterWebUrl = source.getChapterWebUrl(update.manga, sample)
chapterWebUrl.startsWith(`${source.baseUrl}/series/${routeSlug}/`)
  ? pass(`chapter web url: ${chapterWebUrl}`)
  : fail(`chapter web url is wrong: ${chapterWebUrl}`)

// 17. Can the API be read cross-origin at all?
const probe = await fetch(`${API}/series?per_page=1`, {
  headers: { Origin: 'https://localhost:5173' },
})
const acao = probe.headers.get('access-control-allow-origin')
console.log(
  `\n  api host: HTTP ${probe.status}, access-control-allow-origin=${acao ?? 'ABSENT'}`,
)
console.log(
  acao
    ? '  \x1b[32m→ reachable directly from a browser\x1b[0m'
    : '  \x1b[33m→ no CORS: the browser build must go through the /fenrirealm proxy\x1b[0m',
)

console.log(
  failures === 0
    ? '\n\x1b[32mAll source calls succeeded.\x1b[0m\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
)
process.exit(failures === 0 ? 0 : 1)
