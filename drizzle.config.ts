/**
 * Drizzle Kit config for the *server* schema only.
 *
 * The local browser database is deliberately not managed here: it uses the
 * hand-written, idempotent migrations in src/lib/db/migrate.ts, which run
 * inside the SQLite WASM worker where drizzle-kit cannot reach. Pointing this
 * at `schema.ts` would generate a second, competing migration history for the
 * same tables.
 *
 * `d1-http` talks to D1 over the REST API, so `bun run db:generate` works without
 * a running Worker. Applying is done by `bun run deploy`.
 *
 * `out` holds only drizzle-kit's own state (meta/_journal.json and the
 * snapshots it diffs against); `bun run db:generate` moves each generated .sql
 * into ./migrations, which is what Alchemy applies. The two cannot be one
 * directory: Alchemy rejects a migrations directory containing
 * meta/_journal.json, and converting to drizzle-kit v1's layout would rename
 * every migration away from the names D1 already records as applied.
 */

import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  out: './drizzle',
  schema: './src/lib/db/sync-schema.ts',
  dialect: 'sqlite',
  driver: 'd1-http',
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    databaseId: process.env.CLOUDFLARE_DATABASE_ID!,
    token: process.env.CLOUDFLARE_D1_TOKEN!,
  },
})
