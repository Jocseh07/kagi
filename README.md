# Kagi

Kagi is a manga and light-novel reader with a browser PWA, an Electron desktop
application, and a native Linux Rune application. The browser stores its library
in SQLite-WASM. Rune uses native windows and a separate local SQLite library.

- **Browse** pluggable sources — AsuraScans, MangaDot, ThunderScans, NovelFull,
  plus local folders on disk for comics and novels. See [docs/sources.md](docs/sources.md).
- **Library** with categories, filters, an updates feed and reading history.
- **Reader** in paged or continuous mode, with per-series and global settings.
- **Downloads** queued and stored offline, exportable as CBZ.
- **Themes** from tweakcn, plus a font picker over ~30 variable families.
- **Accounts** (optional) via Clerk, backing the library up to Cloudflare D1 and
  syncing it across devices. See [Sync](#sync) below.

## Native Linux application

Kagi Rune packages the Rust application, a compiled Bun engine, native canvas
support, fonts, and assets. Running the package does not require Bun, Node.js,
Rust, Electron, or a hosted Kagi instance. It has no app authentication, account
billing, or account-based sync.

```sh
bun run rune:dev -- --data-dir "$PWD/.tmp/rune-dev-data"
bun run rune:check
bun run rune:build
bun run rune:verify
```

The build publishes a portable directory and archive under `rune/dist/current/`.
See [Run Kagi Rune on Linux](docs/native.md) for build prerequisites, installation,
data and backup boundaries, optional local CLIProxy setup, and verification.
The web and Electron commands remain unchanged. The account and sync sections
below describe the web application, not Rune.

Native verification completed before database initialization:

| Check | Observed result |
| --- | --- |
| Portable Linux x64 package | Release build and archive checksum passed. |
| Relocated package | Native first-run screen rendered with Bun absent from `PATH`. |
| Startup layouts and fonts | Dark 1200×900 and light 375×760 rendered without font errors. |
| Package integrity | All 1,683 files matched the generated manifest's sizes and SHA-256 hashes. |
| Source cancellation | An older aborted metadata observer left a newer result usable and cached. |
| Native local images | Cover pixels, offline URLs, file-replacement identities, cancellation, and unsafe-path rejection passed isolated checks. |
| Persistent features and performance | Database, generation, recovery, repeat-use, and soak verification remain unrun. |

These checks do not establish complete native feature parity or performance.

## Deploy your own

Kagi runs on a Cloudflare Worker with a D1 database. You need a Cloudflare
account, and optionally a Clerk instance and a Polar product if you want sync
and the paid Sync plan; without them the app is a fully local reader.

```sh
bun install
bun run dev    # local, at https://kagi.localhost
bun run deploy # build and publish to your Worker
```

The local CLI and Cloudflare provider are pinned to Alchemy `2.0.0-beta.85`,
with Effect and its platform packages at `4.1.2`. App commands reuse the shared
`default` profile in `~/.alchemy/`; a profile configured with the matching global
CLI does not need a separate login for Kagi. Upgrade these packages together.

The full walkthrough, from a fresh Cloudflare account to a running instance
with sync and billing, is in [docs/deploy.md](docs/deploy.md). Infrastructure
is declared in `alchemy.run.ts`, which is committed and reads every
deployment value from your env file, so nothing in this repository points at
a live deployment.

The bundled sources scrape third-party sites. Running a public instance is your
responsibility under those sites' terms and your local law.

## Reading position

The reader saves where you are on the device as you read: when scrolling stops, on a page turn, when the tab is hidden, and every 5 s during a scroll that never stops. Each save runs in an idle callback, so it never lands in a scroll frame. Novels keep the paragraph and how far into it, so a chapter reopens on the same paragraph at any window size or font size.

| Check (2026-11-07, local dev server) | Result |
|---|---|
| Reopen at 390x844, 820x1180 and 1440x900 | worst 1.2 lines from where you stopped |
| Reopen while the database is still opening, 60 reloads | same spot every time |
| 60 s continuous scroll | 9 saves, never more than 6.5 s behind |
| Cost of one save | 0.08 ms at p95 |
| Open chapter, idle for 5 min | no saves, flat memory |
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
bun run dev             # local dev server, running the app in workerd
bun run build           # Vite build (shell + Worker) + typecheck
bun run plan            # preview what a deploy would change
bun run deploy          # build and publish
bun run typecheck       # tsc -b --force
bun run lint            # oxlint src
bun run themes:sync     # refresh the bundled tweakcn theme presets
bun run db:generate     # generate a D1 migration from the sync schema
```

Three of the sources withhold CORS and are reached through a same-origin hop:
`src/routes/mangadot.$.ts`, `thunderscans.$.ts` and `novelfull.$.ts`, all over
`src/server/proxy.ts`. Because Alchemy runs the app in workerd during
development too, these are the same code path locally as when deployed —
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

The sync API runs under `bun run dev` as well as when deployed, since both are the
same Worker. To exercise it locally, put the Clerk values in `.env`
(gitignored) — `CLERK_SECRET_KEY`, `CLERK_JWT_KEY`, `CLERK_PUBLISHABLE_KEY`, and
`CLERK_AUTHORIZED_PARTIES` set to the dev origin, e.g. `https://kagi.localhost,http://localhost:3150`.
Without them the routes fail closed with a 500 and the app carries on locally,
which is the intended behaviour for a keyless build.

### Setup

`.env.example` is the template. Your deployment's real values go in `.env`
(used by `bun run dev`) and `.env.prod` (used by `bun run deploy`), both
gitignored. `alchemy.run.ts` reads every one of them, so there is no config
file to edit and no id to paste anywhere.

```sh
cp .env.example .env
cp .env.example .env.prod

bun run --bun alchemy profile edit --profile default --add Cloudflare
bun run deploy          # creates the Worker, D1, rate limits and domain,
                        # and applies every migration in migrations/
```

Add `-- --adopt` to the first deploy if a `kagi-sync` database already exists.

Then fill in `.env.prod`:

- `APP_DOMAIN` — your custom domain, e.g. `kagi.example.com`
- `APP_ORIGIN` — the same host as a URL, sent to MangaDex as the User-Agent
  contact
- `VITE_CLERK_PUBLISHABLE_KEY` and `CLERK_PUBLISHABLE_KEY` — the same `pk_...`
  key, once for the client bundle and once for the Worker
- `CLERK_SECRET_KEY` and `CLERK_JWT_KEY` — from the Clerk dashboard; the JWT
  key is the PEM public key, for networkless verification
- `CLERK_AUTHORIZED_PARTIES` — comma-separated origins allowed to mint tokens,
  e.g. `https://kagi.example.com`. **Required**: the sync routes refuse every
  request when it is unset, because accepting tokens from any origin is a CSRF
  hole.
- `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_PRODUCT_ID`,
  `POLAR_SERVER` — the Sync plan

Secrets are uploaded by the deploy itself; there is no separate step for them.
Request budgets for the source proxies and the sync API — tiered for
anonymous, signed-in and subscribed readers — are the rate-limit bindings in
`alchemy.run.ts`; see [docs/deploy.md](docs/deploy.md).

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
