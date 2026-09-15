import { Toaster as Sonner } from 'sonner'
import type { ToasterProps } from 'sonner'
import type { CSSProperties } from 'react'

/**
 * The toast layer, dressed in this app's tokens.
 *
 * Sonner paints itself from a handful of CSS variables rather than classes,
 * so the theme is handed over by repointing those at the semantic tokens —
 * which is what keeps a toast correct under every runtime preset, light or
 * dark, instead of only under the default neutral one.
 *
 * Offset clears `AppHeader` (h-14) with the page gutter's worth of air beneath
 * it, so a toast reads as belonging to the page rather than covering the nav.
 */
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      position="top-right"
      offset={{ top: '4.5rem', right: '0.75rem' }}
      mobileOffset={{ top: '4rem', right: '0.5rem', left: '0.5rem' }}
      gap={8}
      // Failures never expire (see lib/ui/toast), so there has to be a way to
      // put one away that is not "swipe it", which a mouse does not do.
      closeButton
      toastOptions={{
        classNames: {
          // Only the icon carries the failure colour: a whole destructive
          // surface for "could not queue that chapter" outshouts the page.
          error: '[&_[data-icon]]:text-destructive',
          description: 'text-muted-foreground',
          closeButton:
            'bg-popover text-muted-foreground border-border hover:text-foreground',
          actionButton:
            'bg-primary text-primary-foreground hover:bg-primary/90 rounded-md',
          cancelButton: 'bg-muted text-muted-foreground rounded-md',
        },
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius-lg)',
        } as CSSProperties
      }
      {...props}
    />
  )
}
