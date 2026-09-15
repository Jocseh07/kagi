# Deploy your own Kagi

Kagi is one Cloudflare Worker: it serves the app shell, proxies the sources
that block CORS, and runs the optional sync API against a D1 database. You can
run it as a purely local reader with nothing but a Cloudflare account, and add
accounts, sync and the paid Sync plan later.

## What you need

| Part | Required | Used for |
|---|---|---|
| Cloudflare account, free plan | Yes | Worker, static assets, D1 |
| A domain on Cloudflare | Yes | The Worker's custom domain |
| Clerk instance | Optional | Sign-in, so a library can be backed up and synced |
| Polar product | Optional | Charging for the Sync plan |
| Node 22+, pnpm 10+ | Yes | Building |

Without Clerk, no sign-in appears anywhere and the app is a fully offline
reader. Without Polar, signed-in users are never granted sync.

## 1. Clone and configure

```sh
git clone <this repository> kagi && cd kagi
pnpm install

cp wrangler.jsonc     wrangler.local.jsonc
cp .env.example       .env
cp .dev.vars.example  .dev.vars
```

The three copies are gitignored. `wrangler.jsonc` in the repo is only a
template; `pnpm dev`, `pnpm build`, `pnpm run deploy` and the `db:*` scripts
all use `wrangler.local.jsonc` whenever it exists.

Edit `wrangler.local.jsonc`:

```jsonc
"routes": [{ "pattern": "kagi.your-domain.com", "custom_domain": true }],
"vars": {
  "APP_ORIGIN": "https://kagi.your-domain.com",
  // leave the Clerk and Polar values as they are for now
}
```

Keep `"name": "kagi"` unless you want a different Worker name; the custom
domain is bound to that name, so rename both together.

## 2. Create the database

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create kagi-sync
```

Paste the printed `database_id` into `d1_databases[0].database_id` in
`wrangler.local.jsonc`, then create the tables:

```sh
pnpm db:migrate
```

D1 is needed even for a local-only reader because the Worker binds to it at
startup. Nothing is written to it until someone signs in.

## 3. Deploy

```sh
pnpm run deploy
```

Note `pnpm run`: bare `pnpm deploy` is a built-in pnpm command and will fail.
The first deploy attaches the custom domain; DNS for it is created for you.
Open `https://kagi.your-domain.com` and you have a working reader.

## 4. Accounts and sync (optional)

Create an application at [clerk.com](https://clerk.com). From its API keys
page you need the publishable key, the secret key, and the JWKS public key in
PEM form (Dashboard → API keys → "Show JWT public key").

Put the public values in `wrangler.local.jsonc`:

```jsonc
"CLERK_PUBLISHABLE_KEY": "pk_live_...",
"CLERK_AUTHORIZED_PARTIES": "https://kagi.your-domain.com"
```

`CLERK_AUTHORIZED_PARTIES` must be the exact browser origin. The sync routes
refuse every request when it is unset, because accepting tokens from any origin
would be a CSRF hole.

Put the same publishable key in `.env` so it is baked into the client bundle:

```sh
VITE_CLERK_PUBLISHABLE_KEY=pk_live_...
```

Store the secrets on the Worker; they never go in any file:

```sh
pnpm exec wrangler secret put CLERK_SECRET_KEY -c wrangler.local.jsonc
pnpm exec wrangler secret put CLERK_JWT_KEY    -c wrangler.local.jsonc   # paste the PEM
```

Redeploy. Sign-in now appears in Settings.

## 5. The paid Sync plan (optional)

Create a product at [polar.sh](https://polar.sh) and an organization access
token. Then:

```jsonc
"POLAR_PRODUCT_ID": "<product uuid>",
"POLAR_SERVER": "production"     // or "sandbox" while testing
```

```sh
pnpm exec wrangler secret put POLAR_ACCESS_TOKEN   -c wrangler.local.jsonc
pnpm exec wrangler secret put POLAR_WEBHOOK_SECRET -c wrangler.local.jsonc
```

In Polar, add a webhook pointing at
`https://kagi.your-domain.com/api/polar/webhook` for the subscription events
and use its secret above. Redeploy.

If you want sync for free, skip Polar and grant entitlement yourself: see
`src/server/polar.ts` for the D1 row the sync routes check.

## Local development

`pnpm dev` runs the app in workerd at `http://localhost:3150`, using
`wrangler.local.jsonc` for bindings and `.dev.vars` for secrets. For sync in
dev, fill `.dev.vars` with a Clerk **test** instance and set
`CLERK_AUTHORIZED_PARTIES=http://localhost:3150`. `pnpm db:migrate:local`
prepares the local D1.

## Updating a running deployment

```sh
git pull
pnpm install
pnpm db:migrate      # only when the drizzle/ folder gained a migration
pnpm run deploy
```

Your `wrangler.local.jsonc`, `.env` and `.dev.vars` are untouched by a pull.

## Things to know

- Sources scrape third-party sites. Running a public instance is your
  responsibility under those sites' terms and your local law.
- `APP_ORIGIN` is sent to MangaDex as the User-Agent contact, as their API
  terms require. Set it to something that reaches you.
- D1's free plan allows 100,000 row writes per day; see the README's
  "Free-tier limits" for why that is comfortable.
- Requests are budgeted per IP through the two `ratelimits` bindings in
  `wrangler.local.jsonc`: `RATE_PROXY` for the source proxies (200 per 10
  seconds) and `RATE_API` for the sync and billing routes (60 per minute).
  Over budget answers 429. Tune the numbers there; remove the block and
  nothing is throttled.
