# Deploy your own Kagi

Kagi is one Cloudflare Worker: it serves the app shell, proxies the sources
that block CORS, and runs the optional sync API against a D1 database. You can
run it as a purely local reader with nothing but a Cloudflare account, and add
accounts, sync and the paid Sync plan later.

Infrastructure is declared in `alchemy.run.ts` — the Worker, its custom
domain, the D1 database, the rate-limit bindings and every variable. That file
is committed and holds no deployment values: it reads them all from your env
file, so nothing about your deployment ever lands in the repository.

## What you need

| Part | Required | Used for |
|---|---|---|
| Cloudflare account, free plan | Yes | Worker, static assets, D1 |
| R2 enabled on the account | Yes | The `kagi-releases` bucket, created by the deploy |
| A domain on Cloudflare | Yes | The Worker's custom domain |
| Clerk instance | Optional | Sign-in, so a library can be backed up and synced |
| Polar product | Optional | Charging for the Sync plan |
| Node 22+, bun 1.4+ | Yes | Building |

Without Clerk, no sign-in appears anywhere and the app is a fully offline
reader. Without Polar, signed-in users are never granted sync.

## 1. Clone and configure

```sh
git clone <this repository> kagi && cd kagi
bun install

cp .env.example .env
cp .env.example .env.prod
```

Both copies are gitignored. `.env` drives `bun run dev`, `.env.prod` drives
`bun run deploy`; `.env.example` is the template for both and lists every key.

Edit `.env.prod`:

```sh
APP_DOMAIN=kagi.your-domain.com
APP_ORIGIN=https://kagi.your-domain.com
```

and `.env` for local work:

```sh
APP_DOMAIN=kagi.your-domain.com
APP_ORIGIN=http://localhost:3150
```

`APP_DOMAIN` is the custom domain the Worker is bound to. The Worker's name is
`kagi`; the domain is bound to that name, so if you rename it in
`alchemy.run.ts` the domain moves with it.

Leave the Clerk and Polar values empty for now.

## 2. Sign in to Cloudflare

```sh
bun run --bun alchemy profile edit --profile default --add Cloudflare
```

Skip this step if the shared `default` profile is already configured with
Alchemy `2.0.0-beta.85`. Kagi uses that profile from `~/.alchemy/`.

Grant the Workers, D1, and DNS scopes when configuring a new profile. The deploy
creates the database, rate-limit bindings, and custom domain.

D1 is needed even for a local-only reader because the Worker binds to it at
startup. Nothing is written to it until someone signs in.

## 3. Deploy

```sh
bun run deploy
```

The first deploy creates the Worker, the D1 database `kagi-sync`, the four
rate-limit bindings and the custom domain, and applies every migration in
`migrations/`. If a `kagi-sync` database already exists on your account, adopt
it instead of creating a second one:

```sh
bun run deploy -- --adopt
```

Open `https://kagi.your-domain.com` and you have a working reader.

## 4. Accounts and sync (optional)

Create an application at [clerk.com](https://clerk.com). From its API keys
page you need the publishable key, the secret key, and the JWKS public key in
PEM form (Dashboard → API keys → "Show JWT public key").

Put all four in `.env.prod`:

```sh
VITE_CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_SECRET_KEY=sk_live_...
CLERK_JWT_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
CLERK_AUTHORIZED_PARTIES=https://kagi.your-domain.com
```

The publishable key appears twice on purpose: the `VITE_` copy is baked into
the client bundle at build time, the other is read by the Worker. Both must
name the same Clerk instance or tokens fail verification.

`CLERK_AUTHORIZED_PARTIES` must be the exact browser origin. The sync routes
refuse every request when it is unset, because accepting tokens from any origin
would be a CSRF hole.

Secrets stay in `.env.prod` and are uploaded by the deploy; there is no
separate step for them. Redeploy and sign-in appears in Settings.

## 5. The paid Sync plan (optional)

Create a product at [polar.sh](https://polar.sh) and an organization access
token, then add to `.env.prod`:

```sh
POLAR_ACCESS_TOKEN=polar_oat_...
POLAR_WEBHOOK_SECRET=...
POLAR_PRODUCT_ID=<product uuid>
POLAR_SERVER=production     # or sandbox while testing
```

In Polar, add a webhook pointing at
`https://kagi.your-domain.com/api/polar/webhook` for `customer.state_changed`
and use its secret above. Redeploy.

If you want sync for free, skip Polar and grant entitlement yourself: see
`src/server/polar.ts` for the D1 row the sync routes check.

## Local development

`bun run dev` runs the app in workerd at `http://localhost:3150`, reading `.env`
for bindings and secrets alike. For sync in dev, fill `.env` with a Clerk
**test** instance and set `CLERK_AUTHORIZED_PARTIES=http://localhost:3150`.
The local D1 database is created and migrated for you on first run.

### Adaptation generation

Generation settings are device-local. Existing model choices remain in Custom
mode. Fast uses one novel chapter per planning batch and asks for separate comic
chapters, so the first storyboard can start sooner. Balanced reads ahead. Both
preserve the same content-validation requirements and the adaptation's image-check
setting. Switching back to Custom restores the saved individual choices.

The chapter view separates beats from storyboard generation and shows elapsed time,
the model, and retry reasons. A failed settings save retains the typed value.
Text requests allow up to 15 minutes per attempt, including response-body reads;
one planning, beats, or storyboard stage has a 30-minute overall limit across its
attempts. These limits allow slow healthy replies rather than restarting paid work
after an arbitrary short wait. Pause cancels active requests and retry waits.

Dialogue validation and storyboard prompts decode literal Unicode punctuation
escapes such as `\u2014`, including dialogue in previously saved beats. Letter,
digit, and control-character escapes are not decoded. Missing, duplicated, and
invented dialogue still fails validation. If a chapter stopped on escaped
punctuation, resume it after loading the updated app; its saved beats are reused.
No stored chapter is rewritten and no retry starts automatically.

Sheets and panels share one image-request ceiling. Each panel waits only for its
own references; each completed page is composed independently. Paid panel artwork
is saved before image checking, so pausing a check does not discard that artwork.
Interrupted checks resume as checks, not new drawings. Unavailable checks remain
visibly unchecked.

Run the bounded benchmark from the repository root:

```sh
bun scripts/bench-adapt.ts --offline
bun scripts/bench-adapt.ts --live --text-only --max-text-requests 124 --max-image-requests 60 --output .tmp/bench-adapt/text-run-001/results.jsonl
bun scripts/bench-adapt.ts --live --image-only --max-text-requests 180 --max-image-requests 60 --output .tmp/bench-adapt/image-run-001/results.jsonl
```

Live runs share `.tmp/bench-adapt/requests.jsonl`: at most 180 text requests and
60 image requests across invocations, including retries and visual checks.
The text command reserves room for up to 56 image checks. Use a new output path
for each run; never delete the ledger to obtain more quota. A killed run may
leave `.tmp/bench-adapt/.lock`; confirm its recorded process has stopped before
removing only that lock.

Optional `BENCH_ADAPT_ENDPOINT` and `BENCH_ADAPT_API_KEY` override the local proxy
connection. Credentials and provider response bodies are not logged. The benchmark
does not change application settings or existing adaptations.

Three text candidates run concurrently on identical short, dialogue-heavy, and
action-heavy fixtures, twice each. Images use identical references and 18 offered
jobs at each pooled concurrency of 4, 8, and 16. Reports distinguish first-pass
validity, repaired success, timeouts, and unknown quality. These are small-sample
shared-load measurements, not isolated-model latency or guaranteed fidelity.

Fast uses `gpt-6-luna` for planning and storyboards, the fastest text model in
the comparison below. Balanced and the custom defaults use `gpt-6-sol(low)`. All
three use `gpt-image-2.5-flare` for images and 32 concurrent image requests.
`gpt-6-sol(low)` is the proxy's low-reasoning form of `gpt-6-sol`; endpoints
without that naming need a different model in Custom mode.

**Priority speed** (Settings → Generation mode) sends `service_tier: "priority"`
with every text request. It is off by default. CLIProxy forwards it to the Codex
backend for GPT models and drops it for Claude models. On the OpenAI API it is
billed at priority rates. The reply always echoes `default`, so measure speed to
confirm it applies.

The late-October 2026 comparison ran six storyboards per model on the three
fixtures, with all models sharing the proxy. Without priority, median storyboard
times were 44.8 seconds for `gpt-6-luna`, 55.4 for `gpt-6-sol(low)`, 58.5 for
`claude-sonnet-5-5` and 68.1 for `claude-haiku-5-5`. Haiku failed one storyboard
on unknown looks. With priority, `gpt-6-sol(low)` passed all 18 plan, beat and
storyboard stages on the first try, with a 25.8-second median and a 31.2-second
worst storyboard. Its plans took 11.1 seconds. Raw output rose from 43 to 81
tokens per second for `gpt-6-sol` and from 53 to 78 for `gpt-6-luna`;
`service_tier: "ultrafast"` made no difference. This is structural and dialogue
validation, not a semantic story-quality score.

The same 18-panel mixed-model workload took 310 seconds at concurrency four,
206 seconds at eight, and 191 seconds at sixteen. A larger Flare-only comparison
used 64 panels per setting with identical prompts and reference bytes: sixteen
finished in 292 seconds and 32 in 169 seconds, 42% less time. Both returned every
image without retries or timeouts; the first image took 47 seconds at either
setting. This supports 32 for bulk drawing, not faster first images or a measured
end-to-end chapter speedup. Custom settings remain unchanged.

The larger comparison's visual checker accepted 26 of 64 panels at sixteen and
21 of 64 at 32. One sequential batch per setting cannot establish that concurrency
caused the quality difference. All 129 images were 1374 by 1145 instead of the
requested 1536 by 1024.

In the original comparison, the visual checker accepted 11 of 27 Flare panels and 9 of 27 standard-model
panels. Neither reference sheet passed its check. There is no demonstrated
image-quality winner. All 56 PNGs were 1312 by 1199 despite requesting 1536 by
1024; reports now record actual dimensions separately from requested dimensions.
Transport success must not be read as image fidelity or correct output size.

## Desktop app (optional)

`desktop/` is an Electron shell around this deployment. It opens the site in its
own window, so the source proxies and sync still run on the Worker. What it adds
is the adaptation fast lane: a browser opens at most 6 connections to a plain
`http://` host, so "Images drawn at once" above 6 only queues inside the browser.
In the desktop app, requests to a local Adapt endpoint (`localhost`, `127.0.0.1`,
`[::1]`) go through Electron's main process instead, which has no such cap.

```sh
cd desktop && bun install && cd ..
bun run desktop:dev                                 # opens http://localhost:3150, against `bun run dev`
bun run desktop:build                               # desktop/release/*.AppImage
```

- `desktop:dev` always opens the local site, even after a build has written
  `dist/config.json`. `KAGI_URL` overrides it.
- `desktop:build` reads `APP_ORIGIN` from `.env.prod` (or the environment) and
  bakes it into the bundle; the packaged app opens that site. `KAGI_URL`
  overrides it at launch.
- Storage is per site: the local desktop and the deployed one keep separate
  adaptations, even in the same app.
- The main process answers only the app's own page, and only for loopback
  hosts. A remote endpoint keeps using the window's `fetch`.
- The window navigates only within the app's origin; other links open in the
  system browser. A sign-in that redirects to another site opens there too.
- There is no browser chrome, so back and forward arrows float at the bottom
  left of the page. They follow the window's own history and grey out at
  either end. The browser build never shows them.
- The app has its own storage. Library, history and adaptations from a browser
  do not carry over; sync brings the library across.
- One instance at a time, and the page is not throttled while hidden, so
  drawing keeps going minimized.

## Mobile app (optional)

The native app lives in a sibling checkout, `../kagi-mobile`, and builds the
shared code in this repo's `src/lib` directly. It reads sources through this
deployment's proxies and syncs through its `/api/sync` routes, so deploy first.

```sh
cd ../kagi-mobile
cp .env.example .env   # EXPO_PUBLIC_API_ORIGIN, EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY
bun install
bunx expo start
```

- `EXPO_PUBLIC_API_ORIGIN` is this deployment's origin, the same value as
  `APP_ORIGIN`. `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` is the same publishable key;
  leave it empty for a build without accounts.
- Native requests carry no browser origin. If sync answers 401 from the app,
  check the Clerk instance has native API access enabled for the app.
- `bunx expo start` opens it in Expo Go. For an installable build, make a
  development build (`bunx expo run:android` or `run:ios`), or publish a
  signed APK as described below.
- The proxies see the app as an anonymous caller (`RATE_PROXY`, per address).

### Coordinated web and Android releases

The Worker serves complete signed Expo JS/assets updates and signed Android APKs
from the private `kagi-releases` bucket. At launch the app checks its version
behind a loading screen. A confirmed required update blocks further use until the
running installation satisfies it.

Set `APP_ORIGIN` in the web production environment and the same
`EXPO_PUBLIC_API_ORIGIN` in the mobile environment. Deployment addresses stay
in ignored environment files. `APP_RELEASE_ID` selects one immutable release
record for the web deployment and mobile clients.

Releases need two signing keys, both created once and kept outside the
repositories.

The Android release key signs every APK. Android installs an update only over
an app signed by the same key, so keep this key for every release:

```sh
cd ../kagi-mobile
cp .env.release.example .env.release   # set KAGI_KEYSTORE and both passwords
bun run release:keystore
```

The build refuses an APK signed with the Android debug key. Preparation
downloads the published APK and refuses a build whose signing certificate
differs from it.

The OTA key signs every Expo manifest. Create the private key outside both
repositories and put only its public certificate in
`../kagi-mobile/certs/updates.pem`. Expo Updates rejects a certificate without
Digital Signature key usage and Code Signing extended key usage:

```sh
mkdir -p "$HOME/.local/share/kagi-release" ../kagi-mobile/certs
chmod 700 "$HOME/.local/share/kagi-release"
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$HOME/.local/share/kagi-release/private-key.pem" \
  -out ../kagi-mobile/certs/updates.pem -days 3650 -subj '/CN=Kagi updates' \
  -addext 'keyUsage=critical,digitalSignature' \
  -addext 'extendedKeyUsage=critical,codeSigning'
chmod 600 "$HOME/.local/share/kagi-release/private-key.pem"
```

To reissue the certificate from an existing key, replace
`-newkey rsa:2048 -nodes -keyout <path>` with `-new -key <path>`. Check the
certificate before releasing:

```sh
openssl x509 -in ../kagi-mobile/certs/updates.pem -noout -ext keyUsage,extendedKeyUsage
```

The output must list `Digital Signature` and `Code Signing`. Preparation refuses
a certificate without them, or one that does not match the private key.

Back up the keystore, its passwords and the OTA private key. The certificate is
bundled into the APK, so changing it requires a full native release before OTA
updates verify.

```sh
bun run release:prepare --release YOUR_RELEASE_ID
bun run release:publish --release YOUR_RELEASE_ID
```

Preparation builds the release-key-signed APK, checks its package, native build,
fingerprint runtime and embedded update identity, exports complete JS/assets,
signs the exact Expo manifest bytes and builds the matching web app.
Publication checks that no D1 migrations are pending, verifies unchanged source
and artifact hashes, uploads immutable objects, verifies their stored bytes and
writes the release record last. It then deploys the web with that release selected.
After deployment the selector is saved to the ignored `.env.prod`, so later
ordinary deployments retain it.

If preparation or upload fails, activation stops. Retrying a prepared release
cannot overwrite immutable objects with different bytes. Changes after preparation
require a new release ID. `bun run release` performs preparation and publication
as one command; the mobile release command hands off to the same coordinator.

For a compatible JS-only release:

```sh
bun run release:prepare --release YOUR_RELEASE_ID --ota --base ACTIVE_RELEASE_ID
bun run release:publish --release YOUR_RELEASE_ID
```

A matching native runtime receives the current complete snapshot directly,
including clients 3 or 10 versions behind. Runtime changes require one current APK,
without installing intermediate versions. Existing installations need one full
APK installation to acquire the updater. Native builds remain arm64-v8a.

The original build 2 signing key was lost. The new baseline retains
`app.kagi.reader` with a new certificate. Android cannot install it over builds
signed with the original certificate. Before uninstalling, export the library
through Settings, Data and save the backup outside the app. Uninstall the old app,
install the new APK and restore the backup through Settings, Data. The SQLite
backup excludes downloaded chapters and imported comics or novels. Retain the
original imported files, reimport them and download chapters again. Uninstalling
deletes all app-private data. Subsequent releases retain the replacement key and
support normal in-place updates. Keep a permission-restricted backup of the
keystore and its credentials outside the repositories.

`/api/app-update` resolves installed platform, native build, runtime and update ID.
`/api/app-updates` implements the signed Expo Updates protocol.
`/download/releases/<release-id>/<artifact>` serves only artifacts declared in a
validated release record, with immutable caching, HEAD and range support.
Existing `/api/app/release` and `/download/android` consumers keep their shapes.

If the version check fails because the device is offline or the server cannot
be reached, the app opens on the installed version and works offline. When the
connection returns, it checks again and shows the required update. Download
verification checks bytes,
package, build and signing identity before Android opens its installer. Android
still requires user consent and unknown-source permission. Cancellation leaves the
verified download available for retry. Completion is checked against the running
build or update ID, never an installation intent.

The update checkpoint saves the active route, editable drafts, open sheets and
reading position. It drains queue saves, source update work, sync, UI mutations
and SQLite statements before restart or installation. Existing SQLite migrations
apply every historical version in order; the release process never deletes the
local database or offline library. Draft snapshots are scoped to the signed-in
account or local profile and stay in app-private SQLite-backed storage.

Recovery publishes a new OTA update identity or a higher native build. Android
never downgrades. Preserve old immutable artifacts for pinned downloads. An explicit
`--withdraw RELEASE_ID` on preparation retires an obsolete mandatory requirement.
A newer verified active release can also satisfy an older requirement.

iOS full updates require a verified App Store listing. No store destination is
invented or enabled by default. Build and store submission remain separate from
Android APK publication.

## Inspect and retry generations

Open **Adaptations**, then **Generation journal**. Recording starts with new
generation requests. Previous prompts and failed attempts cannot be recovered.
The journal captures planning, beats, storyboards, reference sheets, panels,
checks, and prompt rewrites. Each record keeps its request, raw responses,
validation context, errors, and linked replay results.

Each adaptation's **Progress** tab shows its own journal rows, 20 per page.
Filter them by time (5 minutes, 15 minutes, 1 hour, 24 hours or all), status
and stage. The counts and average time follow the filters. **Retry** replays a
failed or interrupted request, then asks before replacing the current result.
The full journal has the same time filter.

### Keep a private recording folder

Desktop mirrors records to `app.getPath('userData')/generations`. The exact path
appears in **Recording settings**. Node-created directories use mode `0700`,
and files use `0600`.

Browsers keep the journal in the separate `kagi-generation-journal` IndexedDB
database. Choose a folder in **Recording settings** to mirror records where
the File System Access API is available. Reconnect the folder after permission
expires. A mirror failure leaves local records available and reports the error
in recording settings. Browsers without folder access use **Export journal**
and **Import journal bundle** instead.

Keep these files outside version control and shared folders. They contain novel
text, prompts, reference images, and generated content. Recording omits
authorization headers and redacts the current API key. The journal does not
enter account sync. There is no automatic retention expiry. Deleting an
adaptation does not delete its journal. Delete journal records separately after
exporting evidence you need to keep.

Each generation has this layout inside the recording folder:

```text
<generation-id>/
	manifest.json
	events.jsonl
	requests/original.json
	requests/<event-id>.json
	responses/<event-id>.json
	artifacts/<artifact-id>.json
	artifacts/<artifact-id>.bin
```

Large validation inputs, such as the chapter text, cast, places, story memory
and earlier beats, are stored once as shared input artifacts and referenced by
ID from each record's `inputs` list. A shared input lives in a directory named
after its own ID, holding only `artifacts/<id>.json` and `artifacts/<id>.bin`,
and is removed when the last record that refers to it is deleted.

Records are written as `schemaVersion` 2. Version 1 records, which keep every
validation input inside `manifest.json`, are still read. The browser journal
moves them to version 2 when it opens, one record per transaction, so an
interrupted move leaves the rest at version 1 and resumes on the next start.
Folder records and imported bundles become version 2 when they are next written.

Artifact metadata includes MIME type, byte count, and SHA-256. ZIP import checks
record versions, paths, hashes, and conflicting IDs before accepting records.
Imports are limited to 256 MiB per entry and 2 GiB in total.

### Let an agent inspect and replay one record

Run these commands from the repository root. Replace `JOURNAL`, `ORIGINAL_ID`,
and `REPLAY_ID` with the folder and generation IDs shown in the app.

```sh
bun scripts/generations.ts list --dir JOURNAL
bun scripts/generations.ts show ORIGINAL_ID --dir JOURNAL
bun scripts/generations.ts retry ORIGINAL_ID --dir JOURNAL --endpoint http://localhost:8317/v1
bun scripts/generations.ts compare ORIGINAL_ID REPLAY_ID --dir JOURNAL
bun scripts/generations.ts propose-apply REPLAY_ID --dir JOURNAL
```

All commands return JSON. `retry` requires current credentials in the
`KAGI_GENERATION_API_KEY` environment variable and an explicit `--endpoint`.
Never put the key in a prompt or journal file. An imported record cannot choose
where the CLI sends credentials.

A replay makes at most one provider request by default. Set `--max-requests`
explicitly for a larger limit, up to 6. The overall default timeout is 30
minutes. `--timeout-ms` accepts 1 through 3600000. Provider request deadlines
still apply. `--attempt N` selects saved attempt input. `--model MODEL` and
`--prompt-file PATH` override the model or user prompt in a new linked record.
The original record stays unchanged. A failed or cancelled replay exits with
status 1 and retains its evidence.

Use the failure and its saved context to diagnose a prompt or code change.
Replay the same record after the change, then compare outputs. This feature
does not edit application code or deploy fixes automatically.

### Review a replacement

`propose-apply` only requests approval. Sync the connected folder or import the
replay bundle, then select **Review proposed replacement** in the dashboard.
Comparison never changes adaptation content.

The confirmation lists affected work. Replacement checks the saved validation
inputs, target, and dependencies against the locally recorded generation.
Changed or deleted targets and repeated application are rejected. Original
state and images are retained as artifacts on the replay record.

Replacement stops conflicting generation work and leaves the adaptation
paused. Resume it explicitly to regenerate dependent work. If clearing
published pages or downloads fails after the atomic replacement, retry
application to finish reconciliation. That retry does not replace the content
twice. Resuming is blocked until reconciliation completes.

### Recover an interrupted file writer

The file backend rejects symbolic links and coordinates writers with per-record
`.lock` directories. A lock error can indicate a live writer or a terminated
process. Close the desktop app, connected browser tabs, and CLI retries before
checking for a stale lock. Remove only the reported lock after confirming that
no writer remains, then retry synchronization. Never clear locks while a writer
is active.

## Updating a running deployment

```sh
git pull
bun install
bun run deploy
```

Pending migrations in `migrations/` are applied by the deploy itself. Your
`.env` and `.env.prod` are untouched by a pull.

## Things to know

- Sources scrape third-party sites. Running a public instance is your
  responsibility under those sites' terms and your local law.
- `APP_ORIGIN` is sent to MangaDex as the User-Agent contact, as their API
  terms require. Set it to something that reaches you.
- D1's free plan allows 100,000 row writes per day; see the README's
  "Free-tier limits" for why that is comfortable.
- Requests are budgeted through the rate-limit bindings declared in
  `alchemy.run.ts`. The source proxies are tiered by who is asking, read from
  the Clerk session cookie: `RATE_PROXY` per address for anonymous callers
  (200 per 10 seconds), `RATE_PROXY_USER` per account for signed-in readers
  (300), and `RATE_PROXY_PAID` per account for Sync plan subscribers (600).
  `RATE_API` covers the sync and billing routes per address (60 per minute),
  before auth. Over budget answers 429. Tune the numbers there; leave a
  binding out and that tier is not throttled.
