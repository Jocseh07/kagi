# kagi — Agent Instructions

TanStack Start + React 19 + Tailwind v4 + shadcn (`radix-nova`) on Cloudflare Workers, D1, and Drizzle. A manga/novel reader.

## UI work

**Read `DESIGN.md` before writing any UI.** It is the design contract; every color, size, spacing value, radius, and duration must trace to a token named there.

The one rule worth repeating here: **the theme is user-swappable at runtime**, so a hardcoded color is a defect, not a preference. See `DESIGN.md` §0.

- Route to the `design` skill for this repo. Not `design-taste-frontend` — this is dense product UI, which that skill excludes by its own scope rule.
- Check `src/components/ui/` before building a primitive. It probably exists.
- Ship loading, empty, and error states in the same change as the happy path. `Skeleton`, `EmptyState`, and `ErrorPanel` already exist.
- Before calling UI done, run the `design-review` skill inline — a quick think-through of the design choices. Never spawn a subagent for it.

## Sources

Every source declares `contentRating: 'safe' | 'mixed' | 'adult'` (`src/lib/sources/types.ts`), mirroring the `SAFE / MIXED / NSFW` rating Keiyoushi puts on each extension. Read the upstream `build.gradle.kts` before rating a new source, and where upstream does not carry the site, read its own genre filters — `Adult`, `Ecchi` and the like make it `mixed`. `safe` is a claim, not a default.

- `ContentRatingBadge` (`src/components/sources/content-rating-badge.tsx`) is the tag. Show it wherever a source is named; it renders nothing for `safe`.
- Settings → Browse hides rated sources through `browse.hideAdultSources` (`src/lib/sources/adult.ts`). It filters the Browse list only: library, history, search and direct URLs are deliberately untouched.
- A new source goes in both `registry.ts` and `catalog.ts`; the registry throws on load if the two disagree.

## Open source

This repository is public (github.com/Jocseh07/kagi). Nothing that identifies or reaches the live deployment may be committed.

- `wrangler.jsonc` is a template with placeholders. The real config is `wrangler.local.jsonc`, gitignored, and `vite.config.ts` plus the `deploy` and `db:*` scripts pick it up automatically. Never put a real domain, D1 id, Clerk key or Polar id in `wrangler.jsonc`.
- Secrets live only in `.env`, `.dev.vars` and `wrangler secret put`. `.env.example` and `.dev.vars.example` list the key names with empty values; keep them in step when a variable is added.
- No personal domain, email or account id in `src/`, `docs/`, `scripts/` or `public/`. Anything that must reach the operator reads an env var (`APP_ORIGIN`, for the MangaDex User-Agent) and falls back to the repo URL.
- Before pushing, grep the staged diff for `pk_live`, `sk_`, `whsec_`, `polar_`, `PRIVATE KEY`, and the deploy domain. Only `.example` placeholders may match.
- `docs/deploy.md` is the self-hosting guide. A change to configuration, bindings or scripts updates it in the same commit.
- Deploy with `pnpm run deploy`. Bare `pnpm deploy` is a pnpm builtin and fails.

## Verification

```
pnpm typecheck
pnpm lint
```

Do not run the smoke scripts (`pnpm smoke*`) unless asked — they hit live sources.
