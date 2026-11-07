/**
 * The top of Settings on a phone: who you are, and the things the desktop
 * header carries as icons but the bottom bar has nowhere to put.
 *
 * Hidden from `md` up, where the header already shows the avatar menu, the
 * Downloads and Adaptations icons and the incognito toggle — see components/app-header.tsx.
 */

import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Download, EyeOff, Sparkles } from 'lucide-react'

import { useAccount } from '@/components/app-nav-items'
import { accentClass } from '@/lib/profile/avatar-accent'
import { ProfileDialog } from '@/components/profile/profile-dialog'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Switch } from '@/components/ui/switch'
import { useDatabaseReady } from '@/lib/db/provider'
import { dbKeys } from '@/lib/db/query-keys'
import { getQueueSummary } from '@/lib/download/queue-repository'
import { useIncognito } from '@/lib/incognito/store'
import { initialsOf } from '@/lib/profile/store'
import { cn } from '@/lib/utils'

export function SettingsMobileHub() {
  const account = useAccount()
  const [incognito, setIncognito] = useIncognito()
  const [editing, setEditing] = useState(false)
  const ready = useDatabaseReady()

  // The same read the app shell runs, so this costs no extra query.
  const summary = useQuery({
    queryKey: dbKeys.queueSummary,
    queryFn: getQueueSummary,
    enabled: ready,
  })
  const counts = summary.data?.counts
  const waiting = (counts?.queued ?? 0) + (counts?.active ?? 0)

  return (
    <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card md:hidden">
      {/* The phone's stand-in for the header avatar, which is desktop-only. */}
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary"
      >
        <Avatar size="lg">
          {/* Only the account identity carries a photo; the local profile
              keeps its picked accent and initials. */}
          {account.imageUrl ? <AvatarImage src={account.imageUrl} alt="" /> : null}
          <AvatarFallback className={cn('font-medium', accentClass(account.accent))}>
            {initialsOf(account.name)}
          </AvatarFallback>
        </Avatar>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{account.name}</p>
          {account.email ? (
            <p className="truncate text-xs text-muted-foreground">{account.email}</p>
          ) : null}
        </div>

        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </button>

      <ProfileDialog open={editing} onOpenChange={setEditing} />

      <Link
        to="/downloads"
        className="flex h-12 items-center gap-3 px-4 text-sm transition-colors hover:bg-secondary"
      >
        <Download className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">Downloads</span>
        {waiting > 0 ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {waiting} in queue
          </span>
        ) : null}
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </Link>

      <Link
        to="/adapt"
        className="flex h-12 items-center gap-3 px-4 text-sm transition-colors hover:bg-secondary"
      >
        <Sparkles className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">Adaptations</span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </Link>

      {/* A row rather than a link: the mode is entered and left here, and the
          banner under the header carries its own way out as well. */}
      <div className="flex h-12 items-center gap-3 px-4">
        <EyeOff className="size-4 shrink-0 text-muted-foreground" />
        <label htmlFor="incognito-mode" className="min-w-0 flex-1 truncate text-sm">
          Incognito
        </label>
        <Switch
          id="incognito-mode"
          checked={incognito}
          onCheckedChange={setIncognito}
        />
      </div>
    </div>
  )
}
