# Kagi

A manga and light-novel reader that runs entirely in the browser, installable as
a PWA. Sources are scraped in the client, the library lives in SQLite-WASM on
the device, and chapters can be downloaded for offline reading.

- **Browse** pluggable sources — AsuraScans, MangaDot, ThunderScans, NovelFull,
  plus local folders on disk for comics and novels. See [docs/sources.md](docs/sources.md).
- **Library** with categories, filters, an updates feed and reading history.
- **Reader** in paged or continuous mode, with per-series and global settings.
- **Downloads** queued and stored offline, exportable as CBZ.
- **Themes** from tweakcn, plus a font picker over ~30 variable families.
- **Accounts** (optional) via Clerk, backing the library up to Cloudflare D1 and
  syncing it across devices. See [Sync](#sync) below.

## Deploy your own

Kagi runs on a Cloudflare Worker with a D1 database. You need a Cloudflare
account, and optionally a Clerk instance and a Polar product if you want sync
and the paid Sync plan; without them the app is a fully local reader.

```sh
pnpm install
pnpm dev        # local, at http://localhost:3150
pnpm run deploy # build and publish to your Worker (bare `pnpm deploy` is a pnpm builtin)
```

The full walkthrough, from a fresh Cloudflare account to a running instance
with sync and billing, is in [docs/deploy.md](docs/deploy.md). No configuration
file in this repository points at a live deployment; each one is a template.

The bundled sources scrape third-party sites. Running a public instance is your
responsibility under those sites' terms and your local law.

## Stack

React 19, TanStack Start (Router + Query) in SPA mode, Tailwind 4 with
shadcn/ui, Drizzle over SQLite-WASM, Vite, deployed to Cloudflare Workers.

The app is client-only by construction — the library lives in SQLite-WASM on
the device — so Start runs with `spa: { enabled: true }`: the build prerenders
only the document shell and every route renders in the browser. What the Worker
serves besides that shell is the source proxies and the sync API, as server
routes under `src/routes/`.

## Scripts

```sh
pnpm dev             # Vite dev server, running the app in workerd
pnpm build           # Vite build (shell + Worker) + typecheck
pnpm run deploy      # build, then wrangler deploy
pnpm preview         # serve the built output locally
pnpm typecheck       # tsc -b --force
pnpm lint            # oxlint src
pnpm themes:sync     # refresh the bundled tweakcn theme presets
pnpm db:generate     # generate a D1 migration from the sync schema
pnpm db:migrate      # apply D1 migrations to the deployed database
```

Three of the sources withhold CORS and are reached through a same-origin hop:
`src/routes/mangadot.$.ts`, `thunderscans.$.ts` and `novelfull.$.ts`, all over
`src/server/proxy.ts`. Because `@cloudflare/vite-plugin` runs the app in workerd
during development too, these are the same code path locally as when deployed —
there is no separate dev proxy to keep in step.

## Sync

Sync is **additive and entirely optional**. Without the configuration below the
app behaves exactly as it always has: no sign-in appears anywhere, and the
library stays in SQLite-WASM on the device. With it, signing in backs the
library up and keeps it in step across devices.

**Decisions travel; the sources' data does not.** What goes up is what the
reader chose: which series they keep, which chapters they have read, how far
into the current one they are, their categories, history and settings. Titles,
descriptions, genres, covers, chapter names, numbers and upload dates stay on
the device — every device fetches those from the source for free, so uploading
them is paying D1 to store a second copy of somebody else's website. A chapter
nobody has touched never leaves the device at all.

Sync is **event-driven**, never timed. A run fires on sign-in, when a chapter
is finished, when the reader is left, when the app comes back into view, when
the connection returns, and when *Sync now* is pressed. Runs are held to one
per thirty seconds, with a burst of events folded into a single run. Each run
is whole: everything waiting goes up, everything the other devices did comes
back.

### The ledger

Every decision is written to a local `facts` table alongside the row the screen
reads, and that table is what syncs. A fact is addressed by *what it is about*
— `asurascans␟/series/some-title␟/chapter-12` — never by a row id. Two devices
that have never spoken produce the same key for the same chapter, so there is
no identity to reconcile.

One rule replaces the old per-column merge: **a fact is replaced only by a
strictly later generation of itself, or by the same generation reaching
further.** The generation counts how many times the reader changed their mind;
the value is the furthest-wins part, which is how reading position stays
monotonic without consulting a clock. No timestamps and no device ids cross the
wire, because neither decided anything.

Nothing is ever deleted. Marking a chapter unread, removing a series, clearing
history: each is a later generation of the same fact with `state = 0`, so a
removal travels exactly like an addition and cannot be lost by arriving out of
order. Applying a fact that is already true writes nothing.

Facts outlive the rows they describe. A chapter marked read on another device
arrives long before this one has fetched that chapter list; the fact waits in
the ledger and is applied the moment the chapter appears. Nothing is dropped
for want of a parent.

What does **not** sync: downloaded page images and novel text, the download
queue, per-source preferences (they may hold credentials), and anything under
`sync.` in settings — those are device-local by design, and page images belong
in R2 rather than D1.

A library that predates the ledger is stated into it once, on first run. Every
device does this and they converge rather than duplicate, because the same
series produces the same key everywhere.

The sync API runs under `pnpm dev` as well as when deployed, since both are the
same Worker. To exercise it locally, put the Clerk values in `.dev.vars`
(gitignored) — `CLERK_SECRET_KEY`, `CLERK_JWT_KEY`, `CLERK_PUBLISHABLE_KEY`, and
`CLERK_AUTHORIZED_PARTIES` set to the dev origin, e.g. `http://localhost:3150`.
Without them the routes fail closed with a 500 and the app carries on locally,
which is the intended behaviour for a keyless build.

### Setup

`wrangler.jsonc` is a template. Your deployment's real values go in
`wrangler.local.jsonc`, which is gitignored and picked up automatically by
`pnpm dev`, `pnpm build`, `pnpm run deploy` and the `db:migrate` scripts whenever
it exists.

```sh
cp wrangler.jsonc wrangler.local.jsonc
cp .env.example .env
cp .dev.vars.example .dev.vars

wrangler d1 create kagi-sync          # paste the id into wrangler.local.jsonc
pnpm db:migrate                       # create the tables

wrangler secret put CLERK_SECRET_KEY  # from the Clerk dashboard
wrangler secret put CLERK_JWT_KEY     # PEM public key, for networkless verification
wrangler secret put POLAR_ACCESS_TOKEN
wrangler secret put POLAR_WEBHOOK_SECRET
```

Then fill in `wrangler.local.jsonc` under `routes` and `vars`:

- `routes[0].pattern` — your custom domain
- `CLERK_PUBLISHABLE_KEY` — the `pk_...` key
- `CLERK_AUTHORIZED_PARTIES` — comma-separated origins allowed to mint tokens,
  e.g. `https://kagi.example.com`. **Required**: the sync routes refuse every
  request when it is unset, because accepting tokens from any origin is a CSRF
  hole.
- `POLAR_PRODUCT_ID` and `POLAR_SERVER` — the Sync plan's product
- `APP_ORIGIN` — your public origin, sent to MangaDex as the User-Agent contact
- `ratelimits` — per-IP budgets for the source proxies and the sync API. The
  template's numbers are the defaults; see [docs/deploy.md](docs/deploy.md).

And for the client bundle, in `.env`:

```sh
VITE_CLERK_PUBLISHABLE_KEY=pk_...
```

### Free-tier limits

D1's free plan allows **100,000 row writes per day**, which is the binding
constraint here long before its 5 GB of storage. Facts are what make that
comfortable: a series you favourite costs one row rather than one plus every
chapter of it, a chapter you never open costs nothing, and a whole reading
session of page turns coalesces into one fact per chapter. The push lands as a
single `db.batch()` — one D1 call and one implicit transaction — and a fact the
server already holds at the same generation is refused rather than rewritten,
so re-sending costs a read and not a write. Stating a very large existing
library for the first time is still thousands of row writes, once. Clerk's free
plan allows 50,000 monthly active users with a fixed 7-day session lifetime.
