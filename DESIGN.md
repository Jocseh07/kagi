# DESIGN.md — kagi

The design contract for this app. Read this before writing any UI. Every color, size, spacing value, radius, and duration in new code must trace to a token named here.

Source of truth for the values: `src/index.css`. When this file and that file disagree, `src/index.css` wins and this file is the bug.

---

## 0. The constraint that outranks everything

**The theme is chosen by the user at runtime.** Settings injects a `<style id="app-theme">` block of tweakcn preset variables whose `html:root` selectors outrank the defaults in `src/index.css` by specificity. The default theme is shadcn's `neutral` scaffold, and it is only one of many.

Consequences, all non-negotiable:

- **A literal color in a component is a defect.** Not a style preference — a defect. `#1a1a1a`, `oklch(0.2 0 0)`, `bg-neutral-900`, `text-slate-500` all survive the default theme and break under every other preset. Use the semantic tokens below, always.
- **Never assume the palette is neutral/grayscale.** The default has zero chroma; presets do not. Do not write logic, contrast assumptions, or "it'll look fine" reasoning that depends on gray.
- **Never assume light or dark.** Both `:root` and `.dark` are live, and presets redefine both.
- **`--font-sans`, `--font-serif`, and `--font-mono` are all repointed by presets.** If something must not change with the theme, it needs its own named class — see `.font-brand`.

---

## 1. Visual theme and atmosphere

A reading app. The interface is the frame, never the subject — cover art and chapter text are the only things that should attract the eye. Chrome recedes; content carries the color.

- **Quiet by default.** Flat surfaces, hairline borders, generous use of `muted` for anything secondary.
- **Dense, not airy.** This is a library browser over hundreds of items. Cover grids and chapter lists are the primary surfaces. Whitespace is tight and rhythmic, not luxurious.
- **Motion is near-zero.** See §6. A reader that animates is a reader that annoys.

Reference dials, if a taste skill asks: `DESIGN_VARIANCE 3`, `MOTION_INTENSITY 2`, `VISUAL_DENSITY 7`.

---

## 2. Color tokens and roles

Use the semantic name. Never the resolved value.

### shadcn set — the real tokens

| Token | Role |
|---|---|
| `background` / `foreground` | Page base and default text |
| `card` / `card-foreground` | Raised surfaces, cover tiles, panels |
| `popover` / `popover-foreground` | Menus, dialogs, command palette |
| `primary` / `primary-foreground` | The single main action on a surface |
| `secondary` / `secondary-foreground` | Supporting actions |
| `muted` / `muted-foreground` | De-emphasized surfaces and secondary text |
| `accent` / `accent-foreground` | Hover and active fills on interactive rows |
| `destructive` | Remove from library, delete download |
| `border` / `input` / `ring` | Hairlines, field edges, focus rings |
| `sidebar-*` | Navigation chrome only |
| `chart-1..5` | Data viz only. Never decoration. |

### Reader-only tokens

| Token | Value | Role |
|---|---|---|
| `letterbox` | `oklch(0 0 0)`, fixed | The fullscreen reader's top and bottom bands and its idle veil (`bg-letterbox/80`). True black on purpose: it masks the display edge, like the black `theme-color` the reader already sets. Nowhere else. |

### HeroUI tabs bridge

The Settings tabs are HeroUI's `Tabs`, styled by its per-component sheet. That sheet names colours the app does not have, so `src/index.css` maps them: `default` → `muted` (the track), `segment` / `segment-foreground` → `card` / `card-foreground` (the raised pill). It also shims `status-focused` (`ring-ring/50`), `status-disabled`, `no-highlight` and `shadow-surface` (`shadow-sm`). **Never import `@heroui/styles` whole**: it sets `--background`, `--muted`, `--accent` and friends on `:root` and would overwrite the theme picker.

Only the tabs sheet is imported, so the strip's scroller gets its `overflow-x` from `src/index.css` too — HeroUI keeps that in `components/scroll-shadow.css`, which pulls `scrollbar` utilities and `--scrollbar-*` variables from the base sheet this app does not import. Consequence: the strip scrolls and its chevrons work, but there are no fade edges on the clipped edge.

### Shell aliases — legacy, still live

`--bg`, `--surface`, `--surface-2`, `--fg`, `--fg-muted` are `var()` indirections onto `background`, `card`, `muted`, `foreground`, `muted-foreground`. They surface as `bg-surface`, `text-fg-muted`, etc.

**Prefer the shadcn names in new code.** The aliases exist because they predate the theme picker. Do not add new ones, do not mass-migrate existing ones.

### Pairing rule

Every `bg-x` takes its matching `text-x-foreground`. Mixing pairs (`bg-card` + `text-muted-foreground` on a primary label) is how contrast failures get in, because the pairs are the only combinations guaranteed across every preset.

---

## 3. Typography

| Token | Default | Use |
|---|---|---|
| `--font-sans` | Inter | Everything. `html` is `font-sans`. |
| `--font-serif` | Source Serif 4 | Reader prose only, when the reader picks it |
| `--font-mono` | JetBrains Mono | Numbers, chapter counts, technical values |
| `.font-brand` | JetBrains Mono, **pinned** | The wordmark only |

`--font-heading` aliases `--font-sans`. There is no separate display face.

- `.font-brand` is deliberately not `font-mono` — presets repoint `--font-mono`, and the wordmark is part of the app, not the theme. Never swap it for `font-mono`.
- Reader prose sizing is set **inline from the reader's own settings** and must not be duplicated in classes. `.reader-prose` in `src/index.css` owns chapter body styling via element selectors, because that markup is sanitized source HTML with nowhere to hang a class. Do not add utility classes to chapter content.
- **The root font size is the user's**, set in Settings → Appearance (`src/lib/display/text-size.ts`) as a `font-size` on `html`. Every `rem` in the app scales with it, which is the point: type and spacing grow together. So a hardcoded `px` size or spacing value in UI is a defect twice over — it breaks the token rule *and* it refuses to scale. The one sanctioned exception is the size chooser's own labels, which are a ruler and must not rescale with what they measure.
- Headings: weight 600, tight leading. No tracking games on UI text.

---

## 4. Layout and spacing

### The page rhythm — use these, do not hand-roll

Defined in `src/index.css` `@layer utilities`. Gutter, vertical padding, and block gaps step together at `md` and `lg` so the header can never drift out of sync with the page beneath it.

| Utility | Resolves to |
|---|---|
| `.page-width` | `mx-auto w-full max-w-[1600px]` |
| `.p-page` / `.px-page` / `.py-page` | `2` → `md:3` → `lg:4` |
| `.gap-page` / `.gap-x-page` / `.gap-y-page` | `2` → `md:3` → `lg:4` |
| `.bleed-page` | `-mx-2 px-2` → `md:mx-0 md:px-0` — runs a scrolling row to the window edge on mobile |

**Writing `px-2 md:px-3 lg:px-4` by hand is a defect.** Use `.px-page`. The whole point is that the scale changes in one place.

Use `PageContainer` (`src/components/page-container.tsx`) for page shells rather than reassembling the wrapper.

### Reader letterbox

`.reader-letterbox-top` / `.reader-letterbox-bottom`: the safe-area inset on that edge plus `spacing(6)`. Only the fullscreen reader uses them; the reader's own chrome offsets by the same `6` via `in-data-fullscreen:`.

### Radius

`--radius` is `0.625rem` and every step derives from it: `sm` ×0.6, `md` ×0.8, `lg` ×1.0, `xl` ×1.4, `2xl` ×1.8, `3xl` ×2.2, `4xl` ×2.6. Presets change `--radius`. Use `rounded-md` / `rounded-lg` / `rounded-xl`. Never `rounded-[10px]`.

### Breakpoints

`md` (768) is the real hinge — the page rhythm steps, bleed disengages, and nav moves between `app-bottom-nav` and `app-header` there. Mobile is not an afterthought; this app is read on phones.

---

## 5. Components

`src/components/ui/` is the primitive layer. **Check it before writing anything.** Currently: accordion, avatar, badge, button, card, checkbox, collapsible, command, dialog, dropdown-menu, empty-state, error-panel, error-screen, input, input-group, label, loading-screen, popover, progress, select, separator, skeleton, spinner, switch, tabs, textarea.

shadcn config: style `radix-nova`, base color `neutral`, CSS variables on, icon library `lucide`, aliases `@/components`, `@/components/ui`, `@/lib`.

**HeroUI, tabs only.** `@heroui/react` is installed for its `Tabs` (Settings). Do not reach for other HeroUI components; the shadcn primitives above stay the layer for everything else. See §2 for the token bridge.

### States — the primitives already exist, so there is no excuse

Every data surface needs all four, and each has a primitive:

| State | Use |
|---|---|
| Loading | `Skeleton` / `MangaGridSkeleton` / `LoadingScreen` — shaped like the real content. Never a bare centered `Spinner` for page loads. |
| Empty | `EmptyState` — says what goes here and offers the action. Never "No results." |
| Error | `ErrorPanel` inline, `ErrorScreen` for whole-route failure |
| Success | The content |

Icons are `lucide-react`. Never emoji.

---

## 6. Motion

Deliberately minimal. `tw-animate-css` is available; treat it as a last resort.

- **Allowed:** dialog/popover enter-exit, navigation progress, skeleton shimmer, tap feedback.
- **Banned:** perpetual/infinite loops, scroll-triggered reveals, parallax, magnetic hover, anything on the reader surface.
- Every animation must answer one of: hierarchy, feedback, storytelling, state transition. "It looked cool" ships nothing.
- `transform` and `opacity` only.
- `--duration-dim` (`400ms`, `ease-out`): the fullscreen reader fading down after 20 seconds idle and back on touch.
- `--duration-segment` (`250ms`, `--ease-out-fluid` = `cubic-bezier(0.23, 1, 0.32, 1)`): the Settings tab pill sliding to the chosen tab. A state transition; HeroUI drops it under reduced motion.
- `--ease-smooth` (`ease`) and `--ease-out-fluid` exist because HeroUI's tabs sheet reads them. Add other duration or easing tokens here before using them.
- Honor `prefers-reduced-motion`.

Reading is the use case. Nothing may move while someone reads.

---

## 7. Depth and elevation

Nearly flat. Separation comes from `border` hairlines and `muted` fills, not shadow.

- `card` for genuine surfaces, `popover` for floating layers.
- Shadows only where something actually floats above the page — dialogs, dropdowns, popovers.
- **A card that wraps content needing no elevation is decoration.** In dense lists, group with `divide-y`, `border-t`, or spacing instead.
- Focus: `outline-ring/50` is the global base. Keep focus visible on every interactive element, in every theme.

---

## 8. Do and do not

**Do**

- Reach for `src/components/ui/` first, then compose.
- Use `.page-width`, `.p-page`, `.gap-page`, `.bleed-page` for page rhythm.
- Use semantic token pairs (`bg-card` + `text-card-foreground`).
- Ship loading, empty, and error alongside the happy path, in the same change.
- Keep chapter content styling in `.reader-prose`.
- Let cover art be the color on the page.

**Do not**

- Hardcode any color, in any form. It breaks every non-default theme.
- Hand-roll the page rhythm scale.
- Use arbitrary values (`text-[13px]`, `rounded-[10px]`, `mt-[7px]`) where a token exists.
- Swap `.font-brand` for `font-mono`.
- Add utility classes to sanitized chapter markup.
- Add perpetual motion anywhere.
- Assume the palette is gray, or that the app is in dark mode.
- Wrap dense list rows in cards.

---

## 9. Agent prompt guide

When implementing UI in this repo:

1. Read this file and `src/index.css` before writing.
2. Inventory `src/components/ui/` — the primitive probably exists.
3. Route to the `design` skill, not `design-taste-frontend`. This is dense product UI; the taste skill excludes dashboards, data tables, and multi-step product UI by its own scope rule.
4. Implement with semantic tokens and the page-rhythm utilities only.
5. Verify statically per Gate 3: resolve every class to its value through `src/index.css`, compute contrast ratios numerically, and write the structural outline. **Resolve against at least one non-default theme preset as well as the default** — that is where hardcoded values and mispaired tokens surface.
6. Run the `design-review` skill and fix everything it raises.
7. `pnpm typecheck && pnpm lint`.
