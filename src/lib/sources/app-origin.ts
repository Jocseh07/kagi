/** The origin the source proxies are served from. On the web that is this page. */
export function appOrigin(): string {
  return location.origin
}

/** The URL of one of this app's own API routes. Relative on the web. */
export function apiUrl(path: string): string {
  return path
}
