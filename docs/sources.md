# Sources

## Extensions, sources, and which word means what

Mihon calls them **extensions**: installable Android packages, one per site, each
publishing one or more **sources**. This codebase has no installable anything, so
the two words collapse into one — a source is a TypeScript class under
`src/lib/sources/` that implements the `Source` interface.

When this document says *extension* it means the upstream Kotlin artifact. When it
says *source* it means our implementation.

## What is registered today

Six sources, all English. `registry.ts` is the whole list.

| Source | Kind | Reaches the network by | State |
|---|---|---|---|
| `asurascans` | comic | Direct — the API sends CORS | Working |
| `mangadot` | comic | Same-origin proxy (`/mangadot`) | Working in `pnpm dev` |
| `thunderscans` | comic | Same-origin proxy (`/thunderscans`) | Working in `pnpm dev` |
| `local` | comic | Nothing; reads a folder on disk | Working |
| `local-novel` | novel | Nothing; reads a folder on disk | Working |
| `novelfull` | novel | Same-origin proxy via **curl** (`/novelfull`) | Working in `pnpm dev` |

Three things follow from that table, and they are the shape of the whole
problem:

1. **Only `asurascans` can be read directly.** It is the one host in the app
   that sends `Access-Control-Allow-Origin`.
2. **The three proxied sources only work under `pnpm dev`.** `server.proxy` is a
   dev-server feature; a static build has no proxy in front of it and all three
   sources break until the same hop is reproduced at the deploy target.
3. **`novelfull` has to be fetched by curl, not by Node.** The proxy resolves
   the CORS problem and then runs into a second, separate defence: Cloudflare
   fingerprints the TLS handshake. See "The same-origin proxy, and the wall
   behind it" below — that section is the one to read before adding any scraped
   source.

Sources tried and removed: `wattpad` (works, but user-written fiction rather
than light novels) and `ranobelib` (works, but Russian-only). Both are recorded
in the CORS results table rather than kept as filler.

## Where the upstream extensions come from

The catalogue is [Keiyoushi](https://github.com/keiyoushi/extensions), the
community repo that carried on after Tachiyomi shut down and that Mihon ships as
its default extension repository.

The machine-readable index is:

```
https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.json
```

As of 2026-08-23 it lists **1,374 extensions publishing 2,134 sources**. Each
entry looks like this:

```json
{
  "name": "<Display Name>",
  "packageName": "eu.kanade.tachiyomi.extension.<lang>.<name>",
  "resources": {
    "apkUrl": "https://github.com/keiyoushi/extensions/releases/download/.../tachiyomi-<lang>.<name>-v1.4.33.apk",
    "iconUrl": "https://cdn.jsdelivr.net/gh/keiyoushi/extensions-source@main/src/<lang>/<name>/res/mipmap-xhdpi/ic_launcher.png",
    "jarUrl": "https://github.com/keiyoushi/extensions/releases/download/.../tachiyomi-<lang>.<name>-v1.4.33.jar"
  },
  "extensionLib": "1.4",
  "versionName": "1.4.33",
  "contentWarning": "CONTENT_WARNING_SAFE",
  "sources": [
    {
      "id": "2848420679472350044",
      "name": "<Display Name>",
      "language": "en",
      "homeUrl": "https://example.com"
    }
  ]
}
```

Two fields are worth knowing:

- **`extensionLib`** is the ABI version. The split is currently **1,126 extensions
  on 1.4** and **248 on 1.6**. Our `Source` interface is modelled on 1.6
  (`src/lib/sources/types.ts:1-8`), so a 1.4 extension is a slightly different
  shape upstream — most visibly, 1.6 merged details and chapter fetching into one
  `fetchMangaUpdate` call, which is why our interface has `getMangaUpdate`.
- **`iconUrl`** points at jsDelivr, which serves `Access-Control-Allow-Origin: *`.
  Those icons are directly usable as `SourceInfo.iconUrl`; `src/routes/browse/index.tsx:80-99`
  renders one when present and falls back to a Lucide glyph when it isn't.

The Kotlin itself lives in a separate repo,
[`keiyoushi/extensions-source`](https://github.com/keiyoushi/extensions-source),
under `src/<lang>/<name>/`. Reading it is the fastest way to learn a site's
selectors, endpoints, and quirks even though the code cannot be reused.

## Why we cannot load them

An extension is Kotlin compiled against Android, OkHttp, jsoup, Injekt, and
kotlinx.serialization, packaged as a DEX-bearing APK. There is no path that runs
that in a browser — not transpilation, not a shim, not WASM. The `jarUrl` in every
index entry exists for [Suwayomi](https://github.com/Suwayomi), which runs the
same extensions on a JVM; that is a server, not a browser.

So **every source in this app is a re-implementation, not a port.** The upstream
Kotlin is a specification to read, not code to reuse.

Asura is the worked example. The Kotlin extension scrapes the site's HTML, works
around randomised URL slugs, and performs a page-token handshake. Ours does none
of that — it talks only to `api.asurascans.com`, which the site's HTML origin
isn't. `src/lib/sources/asurascans/index.ts:88-95` records the reasoning inline.
The only things carried across verbatim are the behavioural constants: the 2
requests / 2 seconds budget at `src/lib/sources/asurascans/index.ts:40-42` is
copied from the extension's `rateLimit()` call, and `RateLimiter`
(`src/lib/transport/direct-fetch.ts:13-42`) deliberately matches Mihon's
interceptor semantics, `exclude` predicate included.

## CORS is the gate

Every source reaches the network through `HttpTransport`
(`src/lib/transport/types.ts:26-51`), and the only implementation is
`DirectFetchTransport` — plain `fetch` from the page origin. That means a site is
addable **only if it serves `Access-Control-Allow-Origin` on the endpoints we
need**. Porting effort is not the constraint; this is. Most Mihon extensions
scrape HTML from origins that send no CORS headers at all, and those are simply
unavailable to a browser-only client.

There are two separate questions, and they have different answers:

| Need | Requires CORS? | Consequence if absent |
|---|---|---|
| Reading data (listings, details, chapters, page URLs) | **Yes** | Source is not addable |
| Displaying a page image in `<img>` | No | Works fine |
| Reading page image *bytes* (download, descramble, re-encode) | **Yes** | Images can only be stored opaquely; export and descrambling are impossible |

That third row is the entire reason `public/sw.js` exists. Opaque responses can be
put in the Cache API and handed back to an `<img>` even though JavaScript can
never read them, which is how "save offline" works for a source whose CDN is
closed — see `public/sw.js:133-148` and the explicit save path at
`public/sw.js:225-279`. Chrome pads every stored opaque response to roughly 7 MB
for quota accounting, which is why nothing is cached passively.

### Triage a candidate before writing any code

```sh
curl -s -o /dev/null -D - -H 'Origin: http://localhost:5173' \
  -A 'Mozilla/5.0' 'https://example.com/api/whatever' \
  | grep -iE '^(HTTP/|access-control-allow-origin|content-type)'
```

Run it against the data endpoint **and** against a real page-image URL. A site
that passes the first and fails the second is still worth adding; a site that
fails the first is not addable at all today.

### Results, measured 2026-08-23

| Host | Data | Images | Verdict |
|---|---|---|---|
| `api.asurascans.com` | ✅ reflects origin | ❌ (`cdn.asurascans.com`) | **Added.** Direct. Opaque-image path |
| `api.mangadex.org` | ✅ reflects origin | ✅ `uploads.` + at-home nodes | **Best candidate.** Readable bytes |
| `weebcentral.com` | ❌ 200, no header | — | Not addable |
| `mangapill.com` | ❌ 200, no header | — | Not addable |
| `jumpg-webapi.tokyo-cdn.com` (MangaPlus) | ❌ 403 | — | Blocked outright |
| `api.comick.fun` / `api.comick.io` | ❌ dead / redirects away | — | Needs re-investigation |
| `bato.to`, `mangapark.net` | ❌ no response | — | Not addable |
| `en-thunderscans.com` | ❌ 200, no header | ❌ same origin, no header | **Added.** Proxied; one hop covers both |
| `thunderscans.com`, `en.thunderscans.com` | — | — | **Parked domains.** Not the site. See below |
| `cdn.jsdelivr.net` (extension icons) | ✅ `*` | ✅ `*` | Usable for `iconUrl` |

MangaDex is the only entry where page-image bytes are readable cross-origin,
verified end to end: chapter list → `at-home/server/{id}` → a real 696 KB PNG
returned with `Access-Control-Allow-Origin` reflecting the request origin.

This table is a snapshot. Sites change policy; re-run the probe rather than
trusting it indefinitely.

## Adding a source

### 0. Probe first

The probe decides whether the source is addable at all. A site that serves CORS
headers on the endpoints we need gets a `DirectFetchTransport`; a site that does
not cannot be reached from a browser-only client and is not worth writing.

The transport is the seam (`src/lib/transport/types.ts:26-51`), so parsing,
filters, preferences and identity are written against `HttpTransport` rather
than against `fetch`.

### 1. Read the upstream Kotlin

`keiyoushi/extensions-source/src/<lang>/<name>/`. Note especially the
`build.gradle.kts` `theme` field — a `theme` of `mangathemesia`, `madara`, `mmrcms`
and so on means the extension is a thin config over a shared template, and nearly
all the real behaviour lives in that template's directory rather than the
extension's own. Copy the rate limit, the base URLs, and the parsing rules; ignore
the OkHttp/jsoup mechanics.

### 2. Create the directory

```
src/lib/sources/<id>/
  dto.ts     # wire shapes, if the source talks JSON
  index.ts   # the Source implementation
```

Mirror `src/lib/sources/asurascans/` for a network source or
`src/lib/sources/local/` for one that reads the device.

In `dto.ts`, treat **every** field beyond the identity keys as optional. Real APIs
omit nullable columns rather than sending `null`, and anything assumed present
throws on the first response that lacks it — `src/lib/sources/asurascans/dto.ts:1-9`
says so from experience.

### 3. Implement `Source`

The contract is `src/lib/sources/types.ts:96-157`. Required members:

**Identity** — `id`, `name`, `lang`, `baseUrl`, `nsfw`, `versionCode`, optional
`iconUrl`.

**Capability flags** — `supportsLatest`, `isLocal`, `supportsFilterFetching`,
`supportsRelatedMangas`. The UI reads these rather than special-casing source ids:
`supportsLatest` decides whether Browse shows a Latest tab
(`src/routes/browse/$sourceId.tsx:137`), and `isLocal` suppresses the offline-save
affordances, since a local source serves `blob:` URLs the Cache API cannot store.

**Pacing** — `pageFetchIntervalMs`. Page images are fetched by the service worker,
which never passes through your source's own `RateLimiter`, so the source has to
*publish* the pace it expects instead of enforcing it. Asura derives its value at
`src/lib/sources/asurascans/index.ts:44-57`: nine tenths of the sustainable rate,
keeping a tenth back for the app's own concurrent requests and timer drift. Use
`0` only if there is no host budget at all.

**Data calls** — `getPopularManga`, `getLatestUpdates`, `getSearchMangaList`,
`getMangaUpdate`, `getPageList`. Every one takes an optional `AbortSignal` that
must be threaded down to `fetch`, so a cancelled operation stops in flight rather
than at the next call boundary.

**Filters** — `getFilterList`, plus `fetchFilterData` when options have to be
fetched before the sheet can render.

**URLs** — `getMangaWebUrl`, `getChapterWebUrl`, for "open in browser".

Two conventions matter more than they look:

- **`url` is source-relative identity, and it must be stable.** It is half of the
  `manga_source_url_unique` index (`src/lib/db/schema.ts:39-42`), so a series whose
  `url` changes becomes a *different* series and the user silently loses their
  library entry, history, and downloads.
- **Identity has a fixed shape, and it is not the site's path.** Every source
  uses `/series/<slug>` for a series and `/series/<slug>/chapter/<key>` for a
  chapter, whatever the site's own URLs look like — Asura's site path is
  `/comics/…` and it still uses `/series/…` here. This is not cosmetic: the reader rebuilds
  both stubs from its route params without consulting the source
  (`src/routes/reader/$sourceId.$slug.$chapter.tsx:75-94`), and `chapterKeyOf`
  takes the **last path segment** as the route key
  (`src/components/reader/chapter-picker.tsx:6-8`). A source that invents its
  own shape, or ends a chapter url with a slash, loses offline lookups and
  resume points and will fail in the reader rather than in the browse list.
- **`memo` is source-private scratch space** carried between calls. Use it for
  anything volatile that must not leak into identity — randomised slugs being
  the canonical case. Note that `SManga.memo` is persisted but `SChapter.memo`
  is not: there is no column for it, so anything a chapter needs at read time
  must survive in its `url`.

### 4. Add preferences, if the source has options

Implement `ConfigurableSource` (`src/lib/sources/types.ts:169-173`) and declare
`SourcePreference` entries. There is no UI work: `src/routes/settings/index.tsx:542-593`
renders a card per source generically, persists to the `source_prefs` table, and
`applyStoredPreferences()` (`src/lib/sources/preferences.ts:52-60`) pushes stored
values into the live instance at boot so the first fetch already respects them.

### 5. Register it

```ts
// src/lib/sources/registry.ts
register(new YourSource())
```

The registry (`src/lib/sources/registry.ts:5-22`) is a static, eagerly-constructed
`Map`. Registering is the whole wiring step.

### 6. Smoke-test it against the live site

`scripts/smoke-asura.ts` runs the checks worth running — popular, search,
filters, details, chapters, pages, plus an image-CDN CORS report — outside a
browser. Copy it.

```sh
pnpm smoke                  # Asura
```

Two things make this worth more than it looks:

- **Node enforces no same-origin policy**, so a script exercises the parsing
  without the browser's CORS rules in the way. That separates "is the parsing
  right" from "will a browser let us read this", and the first is what you are
  usually debugging.
- **Node has no DOM.** A scraping source needs a real one, which means
  installing something like `linkedom` as `globalThis.DOMParser` before the
  source is imported. The regex stand-in at `scripts/smoke-asura.ts:10-26` only
  fakes `textContent` and cannot run a selector, which is enough for Asura and
  nothing else.

Assert on identity, not just on counts. A series `url` that comes back carrying
a site's rotating prefix is the failure that silently orphans a user's library
and would otherwise look like a pass.

### What you get for free

Registering a source is enough for it to appear in Browse, get a filter sheet, get
a settings card, and participate in the library, history, downloads queue, offline
saving, and library updates. Every one of those is keyed on `source_id`
(`src/lib/db/schema.ts:21-43`) and dispatches through `getSource(id)`.

### Known rough edges

- `src/lib/updates/update-manager.ts:27-40` paces library update checks with a
  single global `SOURCE_INTERVAL_MS = 1_500`, chosen to suit Asura and applied to
  every source. A per-source value belongs on the interface next to
  `pageFetchIntervalMs`.
- `getRelatedMangaList` / `supportsRelatedMangas` are in the interface and
  implemented by Asura, but nothing in `src/routes` or `src/components` consumes
  them yet.
- The registry is eager, so every source's code sits in the main bundle whether or
  not it is browsed.
- Source ids are free-text strings in `manga.source_id`. Native sources use bare
  ids (`asurascans`, `mangadex`, `local`). If a bridged source ever exposes many
  sub-sources, they need a namespaced form such as `suwayomi:<remote-id>`, and
  that convention should be settled before rows exist rather than migrated after.

## What a closed image CDN costs

Nothing in the app can obtain readable bytes from a host that sends no CORS
headers, and the three operations that need to *read* an image rather than
merely display it degrade accordingly:

| Operation | On a closed CDN |
|---|---|
| Save offline | Works, but the opaque response costs ~7 MB of quota per page whatever it weighs |
| Export to CBZ | `reason: 'cors-blocked'`, impossible |
| Descramble | `ImageReadBlockedError`, impossible |

Asura's CDN (`cdn.asurascans.com`) is closed, so its chapters cannot be
exported and its pages cost quota out of proportion to their size when saved.
Displaying them is unaffected — `<img>` needs no CORS. Descrambling does not
arise: the API serves whole images, and the tile handling the Kotlin extension
needs has no counterpart against this endpoint.

The older `asuracomic.net` name now redirects to `asurascans.com`, and the
`gg.asuracomic.net` CDN this document previously named no longer resolves at
all.

## Thunder Scans

A MangaThemesia site, added 2026-08-25, and the first source where one proxy hop
buys everything: the HTML and the page images are on the *same* origin
(`en-thunderscans.com/wp-content/uploads/manga/…`), so proxying the site makes
the image bytes readable. Everything the "closed image CDN" section above
describes as impossible — CBZ export, descrambling, a saved page costing its
real size — works here. The pages are large, though; one measured 5.9 MB as a
single JPEG.

**The domain is the first trap.** `thunderscans.com` and `en.thunderscans.com`
are both parked: they answer 200 with a script that redirects to an advertising
lander, so a probe against either concludes the source is dead. The live site is
**`en-thunderscans.com`**, with a hyphen, which is what the Keiyoushi index gives
as `homeUrl`.

**Series slugs rotate; chapter slugs cannot be derived.** These are two separate
problems and only one of them has a tidy answer.

Upstream is `MangaThemesiaAlt`, whose distinguishing feature is a rotating
numeric prefix on series slugs — `/comics/0086250808-some-series/`. Only part of
the catalogue carries one at a time (six of thirty on the first listing page when
this was written, all sharing a prefix), which reads as the prefix being applied
in batches. Since `url` is half of `manga_source_url_unique`, identity is always
the **stripped** slug and the prefix never reaches the database.

The extension keeps an hourly-refreshed map from stripped to live slug, scraped
from `/comics/list-mode/`. **That page does not exist on this deployment** — it
renders the advanced-search form — and it turns out not to be needed: the site
answers `/comics/<stripped-slug>/` with a **301 to the current prefixed slug**.
Following that redirect replaces the entire cache, which is why the source holds
no state.

That redirect is also why the proxy entry has a `configure` hook. The `Location`
header is an absolute url on the site's own origin, so without rewriting it back
under `/thunderscans` the browser follows it off the proxy and fails the very
CORS check the proxy exists to avoid. Listings redirect too — `?page=1` is
redirected away rather than served, so it is never sent.

Chapter slugs get no such mechanism because there is no rule to exploit. One
series' chapter 278 is `/…-chapter-278/` and its chapter 1 is `/1482765166-…-1/`
— different prefix, different suffix. So the site's chapter slug is carried
verbatim as the last segment of the chapter `url`, which is the only place it can
live: `SChapter.memo` has no column and is not persisted. The assumption being
made, and it matches upstream's own, is that chapter slugs do not rotate. If they
do, saved chapters break; series identity does not.

Selectors, all verified against the live site:

| What | Selector | Verified |
|---|---|---|
| Listing | `/comics/?order=popular` → `div.listupd div.bsx > a` | 30 rows |
| Title | `.bigor .tt, h3 a`, falling back to `a[title]` | ✓ |
| Next page | `div.hpage a.r` | ✓ |
| Search | `/?s=<query>` — **not `/comics/`**, which ignores the term | 10 rows |
| Series title | `h1.entry-title` | ✓ |
| Cover | `.thumb img` | ✓ |
| Genres | `span.mgen a` | 5 tags |
| Author | `[itemprop="author"] [itemprop="name"]` | ✓ |
| Synopsis | `[itemprop="description"]` | ✓ |
| Status | `.imptdt .status i` | "Ongoing" |
| Chapters | `#chapterlist li[data-num] > a[href]` | 278 chapters |
| Pages | inline `ts_reader.run({…})` → `sources[defaultSource].images` | parsed |

Two of those are worth a second look. **Search and filtering are different
endpoints**: `/comics/` takes `order`, `status` and `type` but ignores a search
term, answering with the unfiltered catalogue rather than an error, so the source
chooses between the two rather than combining them. And **there is no `<img>` for
a page at all** — the reader's images are a JSON blob in an inline script, which
is why `getPageList` reads the response text instead of the parsed document.

Locked chapters are skipped. Upstream renames them with a padlock and points them
at a `#locked-<id>` stub; an entry that cannot be opened is worse than absent once
it is also sitting in the library's unread count and the update feed.

Like `novelfull`, it has no smoke script: scraping needs a DOM and Node has none
without a dependency this repo does not carry.

## Mangakakalot

Added 2026-09-13. Two findings here outlive the source itself: **a Worker is not
a way past a Cloudflare challenge**, and **a 404 can be a refusal**.

### The obvious domain is not addable

`www.mangakakalot.gg` and `www.natomanga.com` — the same family, same template —
serve their homepage and answer *every* deeper path with a managed challenge:
403 plus "Just a moment". Measured against `/genre/all`, `/search/story/<q>` and
`/manga/<slug>`, from three clients:

| Client | Homepage | Deeper paths |
|---|---|---|
| `curl` | 200 | **403, challenge** |
| Node `fetch` | 200 | **403, challenge** |
| `workerd` (scratch worker, this repo's wrangler) | 200 | **403, challenge** |

That third row is the new one. "The same-origin proxy, and the wall behind it"
above ends on curl passing where Node failed, and `curlProxy` was the answer.
Here there is no client that passes, and the proxy this app actually deploys is
the runtime in that third row. Warming a cookie jar from the homepage first
changes nothing. `mangakakalot.com` no longer resolves.

### `mangakakalot.fun` is a MangaHub site

Same brand, different operator: the footer credits `mangahub.io`, covers are on
`thumb.mghcdn.com`, pages on `imgx.mghcdn.com`, and the client bundle carries
`dataSourceKey: "mn01"`, which is the id the API answers as. Its catalogue is
MangaHub's, 43,941 series. curl, Node and workerd all get 200 on every path.

### Its HTML lies about the page count, so this is a JSON source

The chapter page for `naruto/700` renders six `<img>` tags and a "1/6" counter,
while `imgx.mghcdn.com/naruto/700/24.jpg` is a real 483 KB image. Scraping the
reader markup would silently drop most of every chapter. Everything is read from
`POST https://api.mghcdn.com/graphql` instead:

| Need | Query | Verified |
|---|---|---|
| Browse, latest, search | `search(x:mn01,q:"",genre:"all",mod:POPULAR,count:true,offset:0,limit:30)` | 30 rows, `count` 43,941 |
| Sorts | `mod:` `POPULAR`, `LATEST`, `ALPHABET`, `COMPLETED` | all return rows; `NEW` returns none |
| Details + chapters | `manga(x:mn01,slug:"naruto_116"){…,chapters{number,title,date}}` | 913 chapters in one request |
| Pages | `chapter(x:mn01,slug:…,number:700){pages,s}` | 24 files; `number:700.5` works |

`count` is the whole match count rather than the page's, so `hasNextPage` is
answered outright instead of being guessed from a full page.

### Three gates, and all of them answer 404

The endpoint returns a plain **404** — not a 401, not a 403 — when anything is
missing, so a failure reads as a wrong URL rather than as a refusal. Isolated
one at a time:

| Request | Result |
|---|---|
| POST + valid key + `Origin: https://mangakakalot.fun` | **200** |
| Same, no `Origin` | 404 |
| Same, `Origin: http://localhost:5173` | 404 |
| Same, `Referer` but no `Origin` | 404 |
| Valid `Origin`, no key or a fabricated key | 404 |
| `GET /graphql?query=…` | 404 |

The key is `mhub_access`, a 32-hex cookie the site sets on any page load with
`Max-Age=8640000` (100 days). Keys are per-visit and several are valid at once,
so harvesting a fresh one never invalidates one in flight.

None of the three is something a page can do, which is why this source has a
route of its own rather than a `proxyTo` entry: `proxyTo` is GET/HEAD only by
design and forwards no body. `src/server/mangahub.ts` harvests the key, caches
it per isolate, and attaches it and the `Origin`.
`src/routes/mangakakalot.graphql.ts` is the POST handler.

### The key is also the rate limit, and it fails silently

A key carries a query budget. Spent, the API answers `API rate limit excessed!
Go to mangahub.io to continue reading!` — as a GraphQL error under **HTTP 200**,
so nothing about the status says so and a source that only checks the status
reports it as an empty result. Two consequences, both load-bearing:

- **The source inspects `errors` even on a 200.** Without that, a spent key
  looks like a series with no chapters.
- **The remedy is a new key, not a wait.** `mangahubGraphql` treats a
  rate-limit body exactly as it treats a 404: drop the cached key, harvest a
  fresh one, ask once more. That is the same thing the site's own "go to
  mangahub.io" would do for a reader, done on their behalf. Verified with a
  stubbed upstream — one rate-limited reply produces a second key and a second
  query, and the caller sees only the answer.

This is why the hop buffers the reply instead of streaming it: the refusal is
only visible in the body.

### The images need no proxy at all

`imgx.mghcdn.com` reflects the request origin (`access-control-allow-origin:
http://localhost:5173`) and serves with no `Referer`, so page images are fetched
directly and **their bytes are readable** — the good case in the CORS table
above, which is what keeps a saved chapter costing its real size rather than the
~7 MB an opaque response is padded to. Covers on `thumb.mghcdn.com` send no CORS
header and do not need to; they are only ever displayed.

### Two details in the source

- **A chapter is addressed by number, not by slug.** The API keys chapters by
  number, returns an empty `slug` for a good share of them, and takes decimals,
  so `/series/<slug>/chapter/700.5` is the identity. Roughly one series in a
  hundred carries two entries for one number — an alternate upload — and the
  first wins, which is also the one the API's own `chapter(number:)` resolves.
- **Queries are built as text.** The endpoint takes no GraphQL variables, so
  every interpolated value goes through an `escape` that doubles backslashes and
  quotes. A search for a title containing a quote would otherwise end the string
  literal and fail the whole query.

No smoke script: the access key is harvested server-side, so the Node path has
none and the source runs in a browser only.

## Importing a Mihon backup

`src/lib/backup/` reads a `.tachibk` and merges the Asura Scans and Thunder
Scans entries into the library. Everything from any other source is reported as
skipped, by name, in the settings panel before the import runs — a series
imported under a source this app cannot fetch is a row that can never open a
chapter.

**The format has no schema to generate from.** Mihon serialises with
kotlinx-serialization's protobuf encoder and ships no `.proto`; the field
numbers live in `@ProtoNumber` annotations in
`app/.../data/backup/models`. `protobuf.ts` therefore reads the wire format
directly — 200 lines, no dependency — and `mihon.ts` names the fields. Both were
checked against a real 64-series export rather than transcribed and hoped for.
Unknown fields decode and are ignored, so a newer Mihon does not break the
reader.

**The url shapes are the whole job**, and they only differ for one of the two
sources:

| | Mihon stores | we store |
|---|---|---|
| Asura, series | `/series/<slug>` | identical |
| Asura, chapter | `/series/<slug>/chapter/<number>` | identical |
| Thunder, series | `/comics/<slug>/` | `/series/<slug>` |
| Thunder, chapter | `/<chapter-slug>/` (site root, *not* nested) | `/series/<slug>/chapter/<chapter-slug>` |

Asura is a pass-through because the extension already stores the slug with its
random suffix stripped, exactly as `toSManga` does. Thunder needs both halves
rewritten, and the chapter half is the surprising one: MangaThemesia chapter
urls are site-root relative and carry no reference to their series at all.

Getting this wrong is not a cosmetic bug. `chapters_manga_url_unique` is
`(manga_id, url)`, so a mismapped chapter is silently duplicated by the next
library refresh and the imported read state is stranded on the orphan.

**Source identity comes from the backup, not from a constant.** Mihon addresses
sources by a 64-bit hash of name, language and the extension's `versionId`,
which we have no formula for — so `resolveSources` reads the backup's own
`backupSources` list and matches on the name. The ids observed in a real export
are kept only as a fallback for a backup that declares no entry, which is what
an extension uninstalled before the export leaves behind.

**The merge only ever moves forward.** `read`, `last_page_read` and `bookmarked`
are merged with `max()` against the stored row, series details are never
overwritten (what is in the database came from the live source and is newer by
definition), and a local chapter the backup does not mention is untouched. A
re-import of the same file is a no-op. The single exception is
`progress_reset_at`: marking something unread is an explicit instruction, so an
import does not undo it.

**Verifying it.** Two scripts, both against a real file:

```
pnpm mihon:report <file.tachibk>   # what would be imported and what skipped
pnpm mihon:check  <file.tachibk>   # runs the real importer on a real schema
```

`mihon:check` stands the database worker up on `node:sqlite` and speaks its
message protocol, so the embedded migrations, drizzle, `transact` and every
statement in `mihon-import.ts` are the shipping code. It asserts the row counts,
then that a second import changes nothing, that local progress ahead of the
backup survives, that a deliberate un-read is not undone, and that unrelated
local chapters are left alone.

## Light novels

The app reads prose as well as comics. A source declares which by its
`contentKind` (`src/lib/sources/types.ts`): `comic` chapters are a list of
images served through `getPageList`, `novel` chapters are prose served through
`getChapterText`. Everything else — identity, filters, library, history,
categories, the download queue, update checks — is shared, and the UI branches
on the flag rather than on source id, the same way it already does for
`supportsLatest` and `isLocal`.

The upstream equivalent is [LNReader](https://github.com/LNReader/lnreader) and
its [plugin repository](https://github.com/LNReader/lnreader-plugins). Its
`PluginBase` maps onto `Source` almost field for field — `popularNovels`,
`searchNovels`, `parseNovel` and `parseChapter` against our `getPopularManga`,
`getSearchMangaList`, `getMangaUpdate` and `getChapterText`. As with Mihon, the
plugins themselves cannot be reused: they are JavaScript, but they run in React
Native, which enforces no same-origin policy.

### Text is far cheaper to store than images

This is the one place a novel source has it easier than a comic one. Page images
from a closed CDN can never be read by JavaScript, which is why `public/sw.js`
and the whole opaque-cache path exist, and why a saved page costs ~7 MB of quota
whatever it weighs. Prose arrives as a readable string, so it goes straight into
the `chapter_text` table:

| | Comic chapter | Novel chapter |
|---|---|---|
| Stored in | Cache API, opaquely | `chapter_text`, as text |
| Needs the service worker | Yes | No |
| Verification pass | Decode every page as an `<img>` | None needed |
| Quota cost | ~7 MB per page | The bytes it actually weighs |
| Export | CBZ, and impossible on a closed CDN | Always works — a standalone HTML file |

Chapter illustrations are the exception: they are hotlinked at read time, so a
saved chapter's *text* is offline but its images are not.

### CORS results, measured 2026-08-25

The gate is the same as for comics, and it disqualifies almost the entire
LNReader catalogue.

| Host | Data | Verdict |
|---|---|---|
| `api.wattpad.com` | ✅ `*` | Works, but user-written fiction, not light novels. Removed |
| `api2.mangalib.me` (RanobeLib, `Site-Id: 3`) | ✅ reflects origin | Works, but Russian-only. Removed |
| `api.novelpia.com` | ✅ `*` | Korean. Listing only; chapter call untraced |
| `novelfull.com`, `readnovelfull.com`, `novel-bin.com`, `novelcool.com`, `novelhall.com` | ❌ 200, no header | **Proxied.** See below |
| `wuxiaworld.com` (+ `api.wuxiaworld.com`) | ❌ 200 / 530, no header | **Read the row below before believing this one** |
| `api2.wuxiaworld.com` (gRPC-web) | ✅ `*`, preflight allows `POST` + `x-grpc-web` | **Added, unproxied.** See below |
| `lightnovelpub.com`, `fanmtl.com`, `mtlnovel.com`, `novelbuddy.com`, `readlightnovel.me`, `novelhi.com` | ❌ no header | Would need a proxy |
| `syosetu.com` (+ its JSON API) | ❌ 200, no header | Would need a proxy — the painful one |
| `royalroad.com`, `lightnovelworld.com` | ❌ 200, no header | Would need a proxy |
| `scribblehub.com`, `webnovel.com`, `novelupdates.com`, `ranobes.top` | ❌ 403 | Blocked outright |

**No English light-novel aggregator sends CORS headers.** Every one above was
probed and every one refuses. The only two that did — Wattpad and RanobeLib —
turned out to be the wrong content: user-written fiction and Russian
translations respectively. Both were removed rather than kept as filler.

That leaves two routes to English light novels: an EPUB on disk (`local-novel`),
or the same-origin proxy the `mangadot` source already uses.

### The same-origin proxy, and the wall behind it

A source that requests **its own origin** is never subject to a CORS check,
because the request is not cross-origin. `mangadot` has always worked this way,
and `novelfull` copies it exactly:

```ts
function resolveApiBase(): string {
  if (typeof location === 'undefined') return SITE_URL   // Node: direct
  return new URL('/novelfull', location.origin).toString()
}
```

with a matching `server.proxy` entry in `vite.config.ts`. Every URL — covers
included — goes through one `resolve()` helper, so nothing leaks back to the
site's own origin.

There is a real bonus here that only proxied sources get. Because the bytes
arrive same-origin, **JavaScript can read them**, which undoes everything the
"closed image CDN" section above describes: CBZ export works, descrambling is
possible, and a saved page costs its real size instead of the ~7 MB an opaque
response is padded to.

**But CORS is not the only gate, and this is the finding that matters most.**
Measured 2026-08-25, with identical headers on both sides:

| Client | Result |
|---|---|
| `curl` → `novelfull.com` | **200** |
| Node `fetch` → `novelfull.com` | **403**, Cloudflare "Just a moment" challenge |

Same URL, same `User-Agent`, same `Accept` and `Accept-Language`. The difference
is the **TLS/HTTP fingerprint** (JA3/JA4): Cloudflare profiles the ClientHello,
and Node's does not look like a browser's. `X-Forwarded-For` makes no difference;
neither does any header.

Vite's dev proxy runs on Node, so it inherits that fingerprint. Curiously, only
HTML was challenged — cover images proxied fine through the Node path — but the
search, novel and chapter pages all returned 403, which is every page the source
needs. `novelfull.net` and `allnovelfull.com` behave identically. This is a
property of the site's bot protection, not of the proxy pattern: `mangadot`
proxies happily through Node because it is not behind the same defence.

**The fix is `scripts/curl-proxy.ts`** — a dev-server plugin that shells out to
`curl` instead of fetching from Node, since curl's fingerprint does pass. It is
wired up as a plugin rather than a `server.proxy` entry:

```ts
curlProxy({ prefix: '/novelfull', target: 'https://novelfull.com' })
```

Three implementation notes, each of which cost a debugging round:

- **`--dump-header /dev/stderr` does not work** when curl is spawned with piped
  stdio; it fails to open the path. Headers and body are both taken from stdout
  and split apart, consuming one leading block per redirect hop for as long as
  what remains still starts with a status line.
- **The body is never decoded**, so images pass through intact — verified as a
  valid 300×454 WebP.
- **The URL is rebuilt against a fixed origin and checked**, because a path like
  `//evil.example/x` would otherwise re-point it. Arguments go to `spawn` as an
  argv array, never through a shell.

Verified end to end through the dev server: listing 20 rows, search 20 rows,
novel page with its id and synopsis, 3,956 chapters in one request, and a
91-paragraph chapter body.

**Cloudflare in front of a site does not mean the challenge is.** This is the
distinction worth carrying away, because reaching for `curlProxy` by reflex
costs a spawned process per request for nothing. `en-thunderscans.com` answers
`Server: cloudflare` and still serves Node's own `fetch` a normal 200, so it
uses the ordinary `server.proxy` entry. Probe both clients against the real
endpoint and let the answer decide:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -A 'Mozilla/5.0' 'https://example.com/x'
node -e "fetch('https://example.com/x',{headers:{'User-Agent':'Mozilla/5.0'}}).then(r=>console.log(r.status))"
```

Two different numbers mean fingerprinting and `curlProxy`; two 200s mean
`server.proxy` is enough.

**This is development only.** `apply: 'serve'` means the plugin does not exist in
a production build, and the deploy story is genuinely harder than for `mangadot`:
reproducing the hop is not enough, because a plain edge function is as
fingerprintable as Node. That needs `curl-impersonate`, a headless browser
(FlareSolverr), or a runtime whose handshake passes.

### The two novel sources

**`local-novel`** reads EPUB and `.txt` files from the same folder the `local`
comic source uses, partitioning it by file type — `local` lists series folders
and comic archives and explicitly refuses EPUBs, which is the gap this fills. It
has no CORS gate because it has no network, which makes it the source that
cannot be taken away by a change of policy upstream. `epub.ts` parses the
container, the package document, the spine and either the EPUB 3 nav document or
the EPUB 2 NCX. **This is the one that works today.**

**`novelfull`** is ported from the Lightnovel Crawler source of the same name —
a 22-line crawler over a 79-line shared template that is almost entirely CSS
selectors and URL patterns. The parsing carried across; the fetching did not,
because lncrawl runs in Python where no same-origin policy exists.

Every selector below was verified against the live site rather than taken from
upstream, and two of them had drifted:

| What | Selector | Verified |
|---|---|---|
| Search/listing rows | `#list-page .row h3[class*='title'] > a` | 20 rows |
| Novel title | `h3.title` (matches twice, same text) | ✓ |
| Cover | `.book img` | ✓ |
| Synopsis | `.desc-text` | 665 chars |
| Info rows | `.info > div` with an `h3` — **not `li`** as upstream has | Author, Genre, Status |
| Novel id | `#rating[data-novel-id]` | `237` |
| Chapter list | `/ajax-chapter-option?novelId=<id>` → `select > option[value]` | 3,956 chapters in one request |
| Chapter body | `#chapter-content` — **`#chr-content` is the older id** | 91 paragraphs |

Two details worth keeping:

- **Listings are paths, not query parameters** — `most-popular`,
  `latest-release-novel`, `completed-novel` — so a wrong value 404s rather than
  silently returning an unsorted page. `hasNextPage` reads the paginator, never
  a full page of twenty, because a list whose length is a multiple of the page
  size ends *on* a full page.
- **Identity strips `.html`.** `/some-novel.html` becomes `/series/some-novel`.
  `url` is half of `manga_source_url_unique`, so if the site ever drops the
  extension every existing library entry would otherwise become a new series.

It has no smoke script: scraping needs a DOM, and Node has none without a
dependency like `linkedom`. The selectors above were verified with Python's
BeautifulSoup against saved pages instead.

### `wuxiaworld`, and the host that was never probed

The first gRPC-web source in the app, and the correction to a row in the table
above that had been wrong since it was written.

**The site has three hosts and only one of them matters.** `www.wuxiaworld.com`
and `api.wuxiaworld.com` withhold CORS headers, which is what the 2026-08-25
measurement recorded. The SPA does not use either: it renders everything from
`api2.wuxiaworld.com`, which answers a preflight with `access-control-allow-
origin: *` and `access-control-allow-methods: POST`. So the source is direct,
every reader reaches the API from their own IP, and there is no route under
`src/routes/` for it. **Probe the host the site's own client talks to, not the
one in the address bar.**

**The protocol is gRPC-web**, with no JSON transcoding on the deployment. A
unary call is a POST whose body is `0x00`, a four-byte big-endian length and a
protobuf message; the response is a run of those frames ending in one flagged
`0x80` carrying `grpc-status` as HTTP header lines. A non-zero status is an
error even though the HTTP status is 200. `src/lib/sources/wuxiaworld/grpc.ts`
is the whole implementation, deliberately not a gRPC runtime, and it also
carries the protobuf *writer* that `src/lib/backup/protobuf.ts` has never
needed.

**The message shapes come from the site's own bundle.** `/assets/novels.*.min.js`,
`chapters.*.min.js` and `pagination.*.min.js` contain the generated client, with
every field's name, number and type in plain sight. That is far better than
guessing from responses, and every number was still checked against a live call
before being written into `dto.ts`.

| What | Call | Verified |
|---|---|---|
| Listing and search | `Novels/SearchNovels` | 246 novels; `total` is the matched count |
| Novel | `Novels/GetNovel{slug}` | synopsis, genres, status, cover, author |
| Chapters | `Chapters/GetChapterList{novelId}` | 2,203 chapters in one 244 KB request |
| Chapter | `Chapters/GetChapter{slugs}` | by novel slug + chapter slug, no id needed |
| Genres | `Genres/GetGenres{level}` | 11 primary, 22 secondary |
| Unlock terms | `Pricing/GetActivePricing{seriesId}` | free window, wait timer, karma |

Four details worth keeping:

- **Listings page by cursor.** `searchAfterId` takes the last novel of the
  previous page, and the app's `Source` API is page-numbered. The source
  remembers the id each page boundary ended on, so browsing in order costs one
  call per page; a page asked for cold walks forward to it first. Both paths are
  checked against each other in the smoke script.
- **`count` is capped at 100, silently.** Asking for 264 returns 100 with no
  error and no marker, which is why the walk above moves in runs of 96 rather
  than fetching everything up to the wanted page in one call. The first version
  of this source did the latter and returned an *empty* page 11 while still
  claiming a page 12.
- **`status` defaults to `Finished`, not to "any".** Omitting the field hides
  every ongoing novel while still returning a plausible-looking page. `Any` is
  `-1`, which is why the writer sign-extends a negative varint to ten bytes.
- **Genres are matched by name**, unlike Fenrir Realm's ids, so nothing has to
  be remembered between building the filter sheet and running the search.
- **Two languages exist**: 154 novels from Chinese and 92 from Korean. The
  filter offers exactly those.

**The paywall is the thing to understand before using this source.** Each novel
opens with a free window, usually 50 chapters, and everything past it needs
karma, a VIP subscription, or a logged-in reader waiting out an unlock timer.
Against the Gods lists 2,203 chapters and serves 51. A locked chapter is *not*
an error: the API answers `grpc-status: 0` with the whole chapter record and
either omits `content` or returns the opening paragraphs with `isTeaser` set —
1,489 bytes ending mid-sentence, against 8,023 for the free chapter before it.
**Both are the lock**, and reading `content` alone would show that teaser as a
very short chapter. `pricingInfo.isFree` on the chapter *list* says the same
thing ahead of time, and is what the list would filter on if it ever did. The source
lists every chapter with its real numbering and reports what an unlock would
take, read from the novel's own active pricing models: "Locked on WuxiaWorld.
Only the first 50 chapters are free. An account unlocks 2 more every 23 hours."

Content rating is `mixed`, not `safe`. There is no adult section, but `Mature`
is one of the site's own secondary genres and 18 of the 246 novels carry it.

It has **no `chapterTextUrl`/`parseChapterText` pair**, which is a deliberate
absence rather than an omission: Background Fetch can only be handed a URL, and
a gRPC call is a POST with a binary body. `queue-manager.ts` checks for both
halves and falls back to the source's own fetch, so downloads work and simply do
not survive a locked screen.

### Writing a novel source

Steps 0 through 6 above apply unchanged. Three additions:

1. **Set `contentKind = 'novel'` and implement `getChapterText`.** `isTextSource`
   checks both; a source that declares itself a novel without the method is
   rejected rather than failing inside the reader.
2. **`getPageList` must reject.** Nothing should call it, and returning `[]`
   would render as an empty chapter instead of an error.
3. **Everything rendered must go through `sanitizeChapterHtml`**
   (`src/lib/text/sanitize.ts`). Chapter bodies are untrusted input bound for
   `dangerouslySetInnerHTML`. It is an allowlist — unknown elements are dropped,
   `javascript:` and `data:` URLs are stripped, links get `rel="noopener
   noreferrer"` and images `referrerpolicy="no-referrer"`. A source that builds
   HTML from a structured document is safe by construction and still goes
   through it, so there is one place where "what may be rendered" is decided.

An illustrations-only chapter is a real chapter. Judge emptiness on the markup,
never on `textLength`, or a novel's opening art pages will refuse to save.

A smoke script for a *JSON* novel source should install no `DOMParser`
stand-in, unlike `smoke-asura.ts`: the sanitiser detects the missing DOM and
degrades to stripping tags, whereas a fake parser returning `{body: {...}}` would
crash it, since it walks a real node tree.

A *scraping* novel source cannot be smoke-tested under Node at all without a
real DOM — `linkedom` or equivalent, which is a dependency this repo does not
carry. `novelfull` is in that position: its selectors were verified against
saved pages with Python's BeautifulSoup instead, which is worth doing either way
because it separates "is the parsing right" from "will the fetch succeed".

### Reading position

`chapters.last_page_read` means two things depending on the series'
`content_kind`: a page index for a comic, and a **0–1000 permille scroll
position** for a novel, whose chapters have no pages. `pageCount` holds the
matching denominator, so the ratio is meaningful either way and
`useReadingProgress` — including its mark-read-at-the-end rule — needed no
change. Permille rather than percent because at 1% granularity the resume point
of a long chapter lands a screen or two from where the reader stopped.

The consequence to remember: `projectQuotaCost(pageCount)` is meaningless for a
novel, and `listSavedChapters` branches on `contentKind` for exactly that
reason. Running it anyway would bill a saved chapter at 1000 padded pages.

## Route not taken

**A CORS proxy for the closed novel hosts.** NovelFull, Syosetu, Royal Road and
the rest are reachable only through something that is not a browser tab — a
small proxy the user hosts, or the bridge below. Either would unlock effectively
all of LNReader's catalogue in one move, and the transport seam
(`src/lib/transport/types.ts:26-51`) exists so a second `HttpTransport` can be
dropped in without touching a single source. Cost: the user has to run a server.
Not built.

**A self-hosted bridge.** One `Source` implementation that talks to a Suwayomi,
Komga, or Kavita server the user runs. Suwayomi executes the real Keiyoushi
extension JARs on a JVM and exposes an HTTP API whose CORS policy the user
controls, which makes it the only approach that reaches all 2,134 upstream
sources with the actual upstream code rather than a re-implementation of it.
Cost: the user must run a server. Not built.
