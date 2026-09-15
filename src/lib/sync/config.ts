/**
 * Whether this build has an account system at all.
 *
 * Accounts are additive: the app is local-first and completely usable signed
 * out, so a build without a Clerk key must still boot and behave exactly as it
 * did before sync existed. Every Clerk hook throws outside a `ClerkProvider`,
 * which is why this is a module constant rather than a runtime check — callers
 * branch on it to decide whether to *render* a component that uses those hooks,
 * and a constant keeps that decision stable across renders.
 */

export const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as
  | string
  | undefined

export const accountsEnabled = Boolean(clerkPublishableKey)
