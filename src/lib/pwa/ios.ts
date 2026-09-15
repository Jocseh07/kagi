/**
 * iOS, where `beforeinstallprompt` does not exist.
 *
 * WebKit has no install dialog to open, so the app can only point at the Share
 * menu and Add to Home Screen. Detection is by user agent because there is no
 * feature to test for; the cost of getting it wrong is a short instruction
 * panel shown to someone who did not need it.
 *
 * Every browser on iOS counts, not only Safari: iOS 16.4 opened Add to Home
 * Screen to third-party browsers, so excluding Chrome and Firefox only hid the
 * offer from people who can act on it. They all run WebKit and all reach it
 * through the same Share menu, one level deeper.
 *
 * iPadOS reports a desktop user agent, hence the touch check.
 */

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false

  const ua = navigator.userAgent
  const iphone = /iPad|iPhone|iPod/.test(ua)
  const ipad = ua.includes('Macintosh') && navigator.maxTouchPoints > 1

  return iphone || ipad
}
