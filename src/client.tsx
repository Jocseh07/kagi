/**
 * The browser entry point.
 *
 * This overrides Start's default client entry, which is otherwise identical.
 * The reason to own it is the two side effects below: Start also renders the
 * root route in Node to prerender the SPA shell, and neither registering a
 * service worker nor listening for a browser event has any meaning there.
 *
 * The router itself comes from `getRouter` in src/router.tsx — `StartClient`
 * resolves it through the hydration payload rather than taking it as a prop.
 */

import { StrictMode, startTransition } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { StartClient } from '@tanstack/react-start/client'

import { registerServiceWorker } from './lib/offline/register'
// Side effect only: the install prompt fires before the tree renders, and is
// lost unless a listener is already attached.
import './lib/pwa/install-prompt'
import { setPendingUpdate } from './lib/offline/update-prompt'

/**
 * Registered here, before the tree renders, so this call is the one that owns
 * the update callback: `registerServiceWorker` keeps only its first caller's
 * options, and components elsewhere call it to ask about support.
 */
void registerServiceWorker({
  onUpdateReady: setPendingUpdate,
})

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
  )
})
