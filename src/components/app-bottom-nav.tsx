import { Link } from '@tanstack/react-router'

import { BOTTOM_TABS } from '@/components/app-nav-items'

const TAB = [
  'flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground',
  'transition-colors hover:text-foreground data-[status=active]:text-foreground',
].join(' ')

/**
 * Below `md` the destinations live down here rather than behind a menu button,
 * the way Mihon's own bar works: one tap per section, and the current one named
 * as well as lit. Above `md` the header carries them and this is not rendered.
 *
 * The fifth tab is Settings, whose own page carries the account, Downloads and
 * incognito at the top on a phone — see components/settings/mobile-hub.tsx.
 *
 * A flex sibling of the scroller rather than a fixed overlay, so pages need no
 * bottom padding and a page's own sticky footer stacks above it.
 */
export function AppBottomNav() {
  return (
    <nav
      aria-label="Main"
      className="shrink-0 border-t border-border bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <div className="grid h-14 grid-cols-5">
        {BOTTOM_TABS.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            // `data-status` rather than `activeProps`, so the active colour
            // wins by variant order instead of by class-string order.
            className={TAB}
          >
            <item.icon className="size-5" />
            <span className="text-[11px] leading-none font-medium">{item.label}</span>
          </Link>
        ))}
      </div>
    </nav>
  )
}
