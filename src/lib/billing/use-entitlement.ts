/**
 * Whether the signed-in account has the Sync plan, as a query.
 *
 * Keyed on the user id so signing out and in as somebody else refetches, and
 * `undefined` until known so callers can tell "loading" from "no plan".
 *
 * Only mounted when a Clerk key is configured; `useAuth` throws outside a
 * `ClerkProvider`. The caller does that check — see lib/sync/config.ts.
 */

import { useCallback } from 'react'
import { useAuth } from '@clerk/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { fetchEntitlement, fetchPlan, openCheckout, openPortal } from './client'
import type { EntitlementStatus } from './client'

export const billingKeys = {
  entitlement: (userId: string | null | undefined) =>
    ['billing', 'entitlement', userId ?? null] as const,
  plan: ['billing', 'plan'] as const,
}

export interface EntitlementView {
  /** `undefined` while loading or signed out. */
  active: boolean | undefined
  status: EntitlementStatus | undefined
  loading: boolean
  error: string | null
  /** Asks Polar directly, for the return from checkout. */
  refresh: () => Promise<void>
}

export function useEntitlement(): EntitlementView {
  const { isSignedIn, userId, getToken } = useAuth()
  const queryClient = useQueryClient()
  const key = billingKeys.entitlement(userId)

  const query = useQuery({
    queryKey: key,
    queryFn: () => fetchEntitlement(getToken),
    enabled: isSignedIn === true && Boolean(userId),
    staleTime: 60_000,
  })

  const refresh = useCallback(async () => {
    const status = await fetchEntitlement(getToken, true)
    queryClient.setQueryData(key, status)
  }, [getToken, queryClient, key])

  return {
    active: query.data?.active,
    status: query.data,
    loading: query.isPending && query.fetchStatus !== 'idle',
    error: query.error ? query.error.message : null,
    refresh,
  }
}

/** Starts checkout; the page leaves for Polar on success. */
export function useCheckout() {
  const { getToken } = useAuth()
  return useMutation({ mutationFn: () => openCheckout(getToken) })
}

/** Opens Polar's customer portal; the page leaves on success. */
export function usePortal() {
  const { getToken } = useAuth()
  return useMutation({ mutationFn: () => openPortal(getToken) })
}

/** The Sync plan's name and price. Needs no account. */
export function usePlan() {
  return useQuery({
    queryKey: billingKeys.plan,
    queryFn: fetchPlan,
    staleTime: 10 * 60_000,
  })
}

/** Shared by the profile dialog and Settings → Sync so the copy has one home. */
export const PLAN_INCLUDES = [
  'Library and reading progress kept in step across your devices',
] as const

export const ALWAYS_FREE = [
  'Reading, downloads, and history on this device',
  'Backup export and import',
] as const
