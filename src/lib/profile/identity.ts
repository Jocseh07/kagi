/**
 * Which identity the app wears: the signed-in account, or the local profile.
 *
 * Signed in, the account's details are used outright. Signed out, or on a
 * keyless build, the local profile, exactly as before. The local profile is
 * never deleted or edited by signing in; it is simply not shown until the
 * account signs out.
 *
 * A module store mirroring the Clerk user rather than Clerk hooks in the
 * consumers, because every Clerk hook throws outside a `ClerkProvider` and the
 * header must render on keyless builds. The bridge in the root layout — which
 * is only mounted when accounts are enabled — pushes the user in; everything
 * else reads from here safely on any build.
 */

import { useSyncExternalStore } from 'react'

import { useProfile } from '@/lib/profile/use-profile'
import { accountsEnabled } from '@/lib/sync/config'

export type AccountUser = {
  id: string
  name: string
  email: string
  imageUrl: string
}

export type Identity = {
  name: string
  email: string
  accent: string
  imageUrl?: string
}

/**
 * The initials fallback colour when the account's photo has not loaded.
 * Neutral rather than one of the profile accents: the accent is a local-profile
 * concept the user picked, and borrowing it under an account photo would imply
 * the two identities are the same thing.
 */
const ACCOUNT_ACCENT = 'slate'

type IdentityState = {
  user: AccountUser | null
  /**
   * Whether Clerk has finished deciding who — if anyone — is signed in.
   *
   * Distinct from `user === null`, which cannot tell "signed out" apart from
   * "not asked yet". Screens that would send a signed-in user somewhere else
   * need that difference: without it they paint the signed-out answer first
   * and correct themselves a beat later.
   */
  resolved: boolean
}

let state: IdentityState = { user: null, resolved: false }

const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): IdentityState {
  return state
}

/**
 * Called by the root layout's bridge whenever the Clerk user changes, and with
 * `null` on sign-out. Guarded by value so the bridge's effect re-running with
 * the same person does not churn every subscriber.
 */
export function setAccountUser(user: AccountUser | null): void {
  const prev = state.user
  const same =
    user === null
      ? prev === null
      : prev !== null &&
        user.id === prev.id &&
        user.name === prev.name &&
        user.email === prev.email &&
        user.imageUrl === prev.imageUrl
  if (same) return

  state = { ...state, user }
  emit()
}

/**
 * Called by the root layout's bridge with Clerk's `isLoaded`. Value-guarded
 * for the same reason `setAccountUser` is: the bridge's effect re-runs on
 * every user change, and only an actual flip is worth a render.
 */
export function setAccountResolved(resolved: boolean): void {
  if (state.resolved === resolved) return
  state = { ...state, resolved }
  emit()
}

export type IdentityView = {
  /** What the header should display, or `null` for the guest floor. */
  identity: Identity | null
  /** Whether `identity` is the signed-in account rather than the local profile. */
  fromAccount: boolean
  /** Whether a signed-in account is known to this store at all. */
  signedIn: boolean
  /**
   * Whether `signedIn` can be trusted yet — true at once on a keyless build,
   * and once Clerk has loaded on every other one.
   */
  accountReady: boolean
}

export function useIdentity(): IdentityView {
  const { profile } = useProfile()
  const { user, resolved } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  )

  const fromAccount = user !== null

  const identity: Identity | null =
    user !== null && fromAccount
      ? {
          name: user.name,
          email: user.email,
          accent: ACCOUNT_ACCENT,
          imageUrl: user.imageUrl || undefined,
        }
      : profile
        ? { name: profile.name, email: profile.email, accent: profile.accent }
        : null

  return {
    identity,
    fromAccount,
    signedIn: user !== null,
    // No bridge is mounted on a keyless build, so nothing would ever resolve
    // this: there is no account system to wait for, and the answer is final
    // from the first render.
    accountReady: !accountsEnabled || resolved,
  }
}
