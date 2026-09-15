/**
 * Chromium's install prompt.
 *
 * `beforeinstallprompt` fires once, early, and is lost unless it is captured
 * and its default suppressed — which is why the listener is attached at module
 * scope from `main.tsx` rather than by a component that may not have mounted
 * yet. Holding the event lets the app open the install dialog on its own terms.
 *
 * Installing matters beyond convenience: an installed site is one of the few
 * signals Chromium accepts for granting persistent storage.
 */

interface BeforeInstallPromptEvent extends Event {
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
  prompt(): Promise<void>
}

export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable'

let deferred: BeforeInstallPromptEvent | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    deferred = event as BeforeInstallPromptEvent
    emit()
  })

  // Covers installs done from the browser's own menu rather than this app.
  window.addEventListener('appinstalled', () => {
    deferred = null
    emit()
  })
}

export function subscribeInstallPrompt(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function canInstall(): boolean {
  return deferred !== null
}

/**
 * Opens the browser's install dialog. The captured event is single use —
 * Chromium rejects a second `prompt()` on it — so it is dropped either way,
 * and the button disappears until Chromium offers another one.
 */
export async function showInstallPrompt(): Promise<InstallOutcome> {
  const event = deferred
  if (!event) return 'unavailable'

  deferred = null
  emit()

  try {
    await event.prompt()
    const { outcome } = await event.userChoice
    return outcome
  } catch {
    return 'dismissed'
  }
}
