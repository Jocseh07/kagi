import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { EyeOff } from 'lucide-react'

import { ACCOUNT_LINKS, NAV, useAccount } from '@/components/app-nav-items'
import { ModeToggle } from '@/components/mode-toggle'
import { usePageBackValue } from '@/components/page-back'
import { accentClass } from '@/components/profile/avatar-accent'
import { ProfileDialog } from '@/components/profile/profile-dialog'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { SyncButton } from '@/components/sync/sync-button'
import { useIncognito } from '@/lib/incognito/store'
import { initialsOf } from '@/lib/profile/store'
import { accountsEnabled } from '@/lib/sync/config'
import { cn } from '@/lib/utils'

export function AppHeader() {
  const back = usePageBackValue()

  return (
    <header className="shrink-0 border-b border-border bg-card">
      {/* Capped and guttered like the pages below, so the brand and avatar
          line up with them. */}
      <div className="page-width relative flex h-14 items-center gap-1 px-page">
        <Link
          to="/library"
          className="font-brand mr-3 shrink-0 text-sm font-semibold tracking-tight"
        >
          Kagi
        </Link>

        {/* Only below `md`: above it the nav fills this row and the details page
            carries its own back button on the cover. Centred on the bar rather
            than trailing the brand, and named rather than arrowed — the
            destination reads as a place, not a direction. */}
        {back && (
          <Link
            to={back.to}
            params={back.params}
            className="absolute left-1/2 max-w-[45%] -translate-x-1/2 truncate text-sm font-medium md:hidden"
          >
            {back.label}
          </Link>
        )}

        <nav className="hidden min-w-0 items-center gap-1 md:flex" aria-label="Main">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              // `data-status` rather than `activeProps`, so the active colour
              // wins by variant order instead of by class-string order.
              className="rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground data-[status=active]:bg-secondary data-[status=active]:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <div className="hidden items-center gap-0.5 md:flex">
            {ACCOUNT_LINKS.map((item) => (
              <Button
                key={item.to}
                asChild
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-foreground data-[status=active]:bg-secondary data-[status=active]:text-foreground"
              >
                <Link to={item.to} aria-label={item.label} title={item.label}>
                  <item.icon />
                </Link>
              </Button>
            ))}
          </div>

          {/* Phone keeps its incognito switch at the top of Settings instead —
              see components/settings/mobile-hub.tsx. */}
          <IncognitoButton />

          {/* Left out entirely on a build with no Clerk key, where its hooks
              have no provider to read. */}
          {accountsEnabled ? <SyncButton /> : null}

          <ModeToggle />

          {/* Below `md` the account and the destinations live in the bottom
              bar instead — see components/app-bottom-nav.tsx. */}
          <div className="hidden items-center md:flex">
            <Separator orientation="vertical" className="mx-1 my-2.5" />
            <UserButton />
          </div>
        </div>
      </div>
    </header>
  )
}

/**
 * One click to the profile, rather than a menu of one destination: editing is
 * the only thing the avatar ever led to.
 */
function UserButton() {
  const account = useAccount()
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="shrink-0 rounded-full"
        aria-label={`Profile: ${account.name}`}
        title={account.name}
        onClick={() => setOpen(true)}
      >
        <Avatar size="sm">
          {/* Only the account identity carries a photo; the local profile
              keeps its picked accent and initials. */}
          {account.imageUrl ? <AvatarImage src={account.imageUrl} alt="" /> : null}
          <AvatarFallback className={cn('font-medium', accentClass(account.accent))}>
            {initialsOf(account.name)}
          </AvatarFallback>
        </Avatar>
      </Button>

      <ProfileDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

/**
 * A toggle rather than a menu item, so the mode can be left from wherever it
 * was entered. The banner under the header carries its own way out as well.
 */
function IncognitoButton() {
  const [incognito, setIncognito] = useIncognito()

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Incognito"
      aria-pressed={incognito}
      title={incognito ? 'Incognito on' : 'Incognito off'}
      className={cn(
        'hidden md:inline-flex',
        incognito
          ? 'bg-secondary text-foreground'
          : 'text-muted-foreground hover:text-foreground',
      )}
      onClick={() => setIncognito(!incognito)}
    >
      <EyeOff />
    </Button>
  )
}
