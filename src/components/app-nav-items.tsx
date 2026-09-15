import { Compass, Download, History, Library, RefreshCw, Settings } from 'lucide-react'

import { useIdentity } from '@/lib/profile/identity'
import type { Identity } from '@/lib/profile/identity'

/**
 * Shared by the desktop header and the mobile bottom bar, so the two never
 * drift on what the app's destinations are.
 */
export const NAV = [
  { to: '/library', label: 'Library', icon: Library },
  { to: '/updates', label: 'Updates', icon: RefreshCw },
  { to: '/browse', label: 'Browse', icon: Compass },
] as const

export const ACCOUNT_LINKS = [
  { to: '/history', label: 'History', icon: History },
  { to: '/downloads', label: 'Downloads', icon: Download },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const

/**
 * The bottom bar's tabs, following Mihon's own five-tab bar: History is a tab
 * of its own there rather than an account icon, and everything left over — the
 * account, Downloads, incognito — lives at the top of Settings, which is the
 * fifth tab. See components/settings/mobile-hub.tsx.
 */
export const BOTTOM_TABS = [
  { to: '/library', label: 'Library', icon: Library },
  { to: '/updates', label: 'Updates', icon: RefreshCw },
  { to: '/history', label: 'History', icon: History },
  { to: '/browse', label: 'Browse', icon: Compass },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const

/**
 * What the menu shows before the welcome has run — reachable only on the
 * welcome route itself, where the chrome is hidden anyway, and as a floor for a
 * browser that refuses localStorage entirely.
 */
const GUEST: Identity = { name: 'Guest', email: '', accent: 'slate' }

/**
 * The resolved identity — the signed-in account or the local profile,
 * whichever the user chose (see lib/profile/identity.ts) — or the guest floor
 * above.
 */
export function useAccount() {
  const { identity } = useIdentity()
  return identity ?? GUEST
}

