/** The native app's Clerk key, inlined at build time. Empty means no accounts. */
export const clerkPublishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY || undefined

export const accountsEnabled = Boolean(clerkPublishableKey)
