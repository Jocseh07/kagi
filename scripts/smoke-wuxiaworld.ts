/**
 * Exercises the WuxiaWorld source against the live API, outside a browser.
 *
 * Run: pnpm exec tsx scripts/smoke-wuxiaworld.ts
 *
 * No DOMParser stand-in is needed. The source parses protobuf, not HTML, and
 * builds no markup of its own, so it behaves here exactly as it does in the
 * browser. `sanitizeChapterHtml` still degrades to tag-stripping under Node, so
 * the chapter checks assert on the text rather than on the markup.
 *
 * Unlike the other novel sources, nothing here is proxied: `api2.wuxiaworld.com`
 * sends `access-control-allow-origin: *`, so this script and the browser build
 * talk to the same host the same way.
 */

const { WuxiaWorld } = await import('../src/lib/sources/wuxiaworld/index.ts')
const { unary, writeInt } = await import('../src/lib/sources/wuxiaworld/grpc.ts')
const { parseSearchNovels } = await import('../src/lib/sources/wuxiaworld/dto.ts')
const { DirectFetchTransport } = await import('../src/lib/transport/direct-fetch.ts')

/**
 * Against the Gods: 2203 chapters, of which the first 51 are free. Picked so
 * that the free-chapter and locked-chapter checks each test the case they name
 * rather than passing by finding nothing.
 */
const PROBE_SLUG = 'against-the-gods'

/** A chapter deep enough into the novel to be well past any free window. */
const LOCKED_INDEX = 200

/** Mirrors the source's own constant; it exports neither. */
const PER_PAGE = 24

const pass = (m: string) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`)
const fail = (m: string) => {
  console.log(`  \x1b[31mFAIL\x1b[0m ${m}`)
  failures++
}
let failures = 0

const source = new WuxiaWorld()
console.log(`\nWuxiaWorld smoke test — ${source.baseUrl}\n`)

// 1. Popular
const popular = await source.getPopularManga(1)
popular.mangas.length === PER_PAGE
  ? pass(`popular: ${popular.mangas.length} novels, hasNextPage=${popular.hasNextPage}`)
  : fail(`popular returned ${popular.mangas.length} novels, expected ${PER_PAGE}`)
console.log(
  `       e.g. ${popular.mangas.slice(0, 3).map((m) => m.title).join(' | ')}`,
)

// 2. Latest — a different sort must not return an identical first page.
const latest = await source.getLatestUpdates(1)
latest.mangas.length > 0 && latest.mangas[0]?.title !== popular.mangas[0]?.title
  ? pass(`latest: ${latest.mangas.length} novels — ${latest.mangas[0]!.title}`)
  : fail('latest returned nothing, or the same ordering as popular')

// 3. Listing cards must arrive complete. Search and detail return the same
//    message, which is why the source marks them initialized — if that stopped
//    being true, every shelf tile would need a second request.
const card = popular.mangas[0]
card?.thumbnailUrl && card.genre?.length && card.description
  ? pass(`listing cards complete: cover, ${card.genre.length} genres, description`)
  : fail(
      `listing card is thin: cover=${Boolean(card?.thumbnailUrl)} genres=${card?.genre?.length ?? 0} description=${Boolean(card?.description)}`,
    )

// 4. Synopses are HTML on the wire and plain text in the app.
!card?.description?.includes('<')
  ? pass(`synopsis reduced to text: ${card?.description?.slice(0, 60)}…`)
  : fail('synopsis still carries markup')

// 5. Search
const search = await source.getSearchMangaList(1, 'martial', source.getFilterList())
search.mangas.length > 0
  ? pass(`search "martial": ${search.mangas.length} hits — ${search.mangas[0]!.title}`)
  : fail('search returned nothing')

// 6. Filter data, both taxonomy levels.
const filterData = await source.fetchFilterData()
filterData.genres.length > 20
  ? pass(
      `genres: ${filterData.genres.length} across both levels — e.g. ${filterData.genres.slice(0, 3).join(', ')}`,
    )
  : fail(`genres: ${filterData.genres.length}, expected both levels`)

// 7. Status filtering, asserted on identity rather than on a count. `Any` is
//    -1 and the field defaults to `Finished`, so a status that failed to encode
//    would silently return completed novels and look like a working filter.
const statusFilters = source.getFilterList(filterData)
const statusFilter = statusFilters.find(
  (f) => f.type === 'select' && f.name === 'Status',
)
if (statusFilter?.type === 'select') {
  statusFilter.state = 1 // Ongoing
  const filtered = await source.getSearchMangaList(1, '', statusFilters)
  const offenders = filtered.mangas.filter((m) => m.status !== 'ongoing')
  filtered.mangas.length > 0 && offenders.length === 0
    ? pass(`filter status=ongoing: ${filtered.mangas.length} novels, all ongoing`)
    : fail(
        `filter status=ongoing: ${filtered.mangas.length} novels, ${offenders.length} not ongoing`,
      )
} else {
  fail('no status filter in the filter list')
}

// 8. Genre filtering. The filter takes genre *names*, so this is the check that
//    the checkbox the reader ticked reached the query as the server reads it.
const genreFilters = source.getFilterList(filterData)
const genreGroup = genreFilters.find((f) => f.type === 'group' && f.name === 'Genres')
if (genreGroup?.type === 'group' && genreGroup.state[0]?.type === 'checkbox') {
  const picked = genreGroup.state[0]
  picked.state = true
  const byGenre = await source.getSearchMangaList(1, '', genreFilters)
  const offenders = byGenre.mangas.filter((m) => !m.genre?.includes(picked.name))
  byGenre.mangas.length > 0 && offenders.length === 0
    ? pass(`filter genre=${picked.name}: ${byGenre.mangas.length} novels, all carry it`)
    : fail(
        `filter genre=${picked.name}: ${byGenre.mangas.length} novels, ${offenders.length} without it`,
      )
} else {
  fail('no genre checkboxes in the filter list')
}

// 9. Page 2 by cursor must not repeat page 1.
const popularTwo = await source.getPopularManga(2)
const overlap = popularTwo.mangas.filter((m) =>
  popular.mangas.some((first) => first.url === m.url),
)
popularTwo.mangas.length > 0 && overlap.length === 0
  ? pass(`page 2: ${popularTwo.mangas.length} novels, none repeated from page 1`)
  : fail(`page 2 repeated ${overlap.length} novels from page 1`)

// 10. The same page asked for cold, with no cursor to work from. A reader who
//     lands mid-list must see the page a sequential reader sees, or the two
//     paths through `browse` disagree and paging is silently wrong.
const coldTwo = await new WuxiaWorld().getPopularManga(2)
const sameOrder =
  coldTwo.mangas.length === popularTwo.mangas.length &&
  coldTwo.mangas.every((m, index) => m.url === popularTwo.mangas[index]?.url)
sameOrder
  ? pass('page 2 without a cursor matches page 2 with one')
  : fail(
      `cold page 2 differs: ${coldTwo.mangas.map((m) => m.title).slice(0, 3).join(', ')}`,
    )

// 11. Pagination must stop at the end, not one page past it. The catalogue size
//     comes from the API's own total rather than from counting pages.
const { total } = parseSearchNovels(
  await unary(
    new DirectFetchTransport(),
    'https://api2.wuxiaworld.com',
    'wuxiaworld.api.v2.Novels/SearchNovels',
    // status=All, sortType=Popular, count=1: the page is irrelevant, the total
    // is the point.
    new Uint8Array([...writeInt(3, -1), ...writeInt(4, 1), ...writeInt(7, 1)]),
  ),
)
const lastPage = Math.ceil(total / PER_PAGE)
const last = await source.getPopularManga(lastPage)
last.hasNextPage
  ? fail(`pagination: page ${lastPage} of ${lastPage} claims another page`)
  : pass(`pagination: ${total} novels, page ${lastPage} ends the list`)

// 12. Details + the whole chapter list, which the API serves in one request.
const target = {
  url: `/series/${PROBE_SLUG}`,
  title: PROBE_SLUG,
  status: 'unknown' as const,
  initialized: false,
  memo: { slug: PROBE_SLUG },
}
const update = await source.getMangaUpdate(target, {
  fetchDetails: true,
  fetchChapters: true,
})
update.manga.title ? pass(`details: ${update.manga.title}`) : fail('no title')
console.log(
  `       status=${update.manga.status} author=${update.manga.author ?? '—'} genres=${update.manga.genre?.length ?? 0}`,
)
update.chapters.length > 1000
  ? pass(
      `chapters: ${update.chapters.length} (${update.chapters[0]?.name} … ${update.chapters[update.chapters.length - 1]?.name})`,
    )
  : fail(`chapters: ${update.chapters.length}, expected the whole list`)

// 13. Chapter dates must not collapse to the epoch.
const dated = update.chapters.filter((c) => c.dateUpload && c.dateUpload > 0)
dated.length === update.chapters.length
  ? pass(`chapter dates parsed: oldest ${new Date(dated[0]!.dateUpload!).toISOString()}`)
  : fail(`${update.chapters.length - dated.length} chapters have no usable date`)

// 14. A free chapter reads.
const first = update.chapters[0]!
const opening = await source.getChapterText(update.manga, first)
opening.textLength > 500
  ? pass(`free chapter "${first.name}": ${opening.textLength} chars`)
  : fail(`free chapter returned ${opening.textLength} chars`)

// 15. A locked chapter must be refused with the site's own terms, not shown.
//     The API answers 200 with the whole record and no body, which would
//     otherwise render as an empty chapter.
const locked = update.chapters[LOCKED_INDEX]
if (locked) {
  try {
    const text = await source.getChapterText(update.manga, locked)
    fail(`locked chapter returned ${text.textLength} chars instead of refusing`)
  } catch (error) {
    const detail = (error as Error).message
    const named =
      /^Locked on WuxiaWorld\./.test(detail) && /\d+ chapters are free/.test(detail)
    if (named) pass(`locked chapter refused: ${detail}`)
    else fail(`locked chapter failed for the wrong reason: ${detail}`)
  }
} else {
  fail(`no chapter at index ${LOCKED_INDEX} to test the paywall against`)
}

// 16. The reader's round trip. It never sees the objects above: it rebuilds a
//     series and a chapter from the two route params, which the app derives as
//     the trailing segment of each url. Anything the source needs that does not
//     survive that trip is a chapter that reads fine from the list and fails on
//     reload.
const routeSlug = update.manga.url.split('/').pop()!
const routeKey = first.url.split('/').pop()!
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
      name: routeKey,
      chapterNumber: 1,
    },
  )
  reread.textLength === opening.textLength
    ? pass(`route round trip: ${routeSlug}/${routeKey} reads the same chapter`)
    : fail(
        `route round trip read a different chapter: ${reread.textLength} vs ${opening.textLength} chars`,
      )
} catch (error) {
  fail(`route round trip failed: ${(error as Error).message}`)
}

// 17. The download queue primes novel chapters through Background Fetch, which
//     can only be handed a URL. A gRPC call is a POST with a binary body, so
//     this source deliberately offers neither half of that pair and the queue
//     falls back to fetching each chapter itself.
const primable = source as {
  chapterTextUrl?: unknown
  parseChapterText?: unknown
}
if (!primable.chapterTextUrl && !primable.parseChapterText) {
  pass('no background-fetch pair, as a POST-only protocol requires')
} else {
  fail('chapterTextUrl/parseChapterText exist but cannot work over gRPC')
}

console.log(
  failures === 0
    ? '\n\x1b[32mAll checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
)
process.exit(failures === 0 ? 0 : 1)
