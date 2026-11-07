let origin: string | null = null

/** Set once at startup by the native app, from its configured API origin. */
export function setAppOrigin(value: string): void {
  origin = value.replace(/\/+$/, '')
}

/** The deployed Kagi origin whose source proxies the native app reads through. */
export function appOrigin(): string {
  if (!origin) throw new Error('The app origin is not configured. Set EXPO_PUBLIC_API_ORIGIN.')
  return origin
}

/** The URL of one of the deployed app's API routes. */
export function apiUrl(path: string): string {
  return appOrigin() + path
}
