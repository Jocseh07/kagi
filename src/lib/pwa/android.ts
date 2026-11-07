/**
 * Android, where the app can also be installed from the published APK.
 *
 * Detected by user agent for the same reason `ios.ts` is: there is no feature
 * to test for. Chrome's "desktop site" mode hides it, which only means the
 * strip is not offered; the Settings row still is.
 */

export function isAndroid(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Android/.test(navigator.userAgent)
}
