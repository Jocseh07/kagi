/**
 * Who you are, opened from the avatar rather than parked on a settings page.
 *
 * Signed in, this is the account and its plan, and nothing else: the local
 * profile is kept in storage for sign-out but is not shown. Signed out, it is
 * the local profile fields the welcome first asked for, plus a way to sign in
 * where a Clerk key is configured.
 *
 * Explicit save rather than save-on-type, because the header is subscribed to
 * the same value and a live-bound name would rewrite it on every keystroke.
 */

import { useState } from 'react'

import { AccountPanel } from '@/components/account/account-panel'
import { DEFAULT_ACCENT } from '@/components/profile/avatar-accent'
import { ProfileFields, type ProfileDraft } from '@/components/profile/profile-fields'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useIdentity } from '@/lib/profile/identity'
import { useProfile } from '@/lib/profile/use-profile'
import { accountsEnabled } from '@/lib/sync/config'

const EMPTY_DRAFT: ProfileDraft = { name: '', email: '', accent: DEFAULT_ACCENT }

function toDraft(profile: { name: string; email: string; accent: string } | null): ProfileDraft {
  if (!profile) return EMPTY_DRAFT
  return { name: profile.name, email: profile.email, accent: profile.accent }
}

type ProfileDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ProfileDialog({ open, onOpenChange }: ProfileDialogProps) {
  const { signedIn } = useIdentity()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{signedIn ? 'Account' : 'Profile'}</DialogTitle>
          <DialogDescription>
            {signedIn ? 'Signed in on this device.' : 'Kept on this device.'}
          </DialogDescription>
        </DialogHeader>

        {signedIn && accountsEnabled ? (
          <AccountPanel />
        ) : (
          /* Keyed on `open` so a reopened dialog starts from what is stored
             rather than from an abandoned draft. */
          <ProfileBody key={String(open)} onDone={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function ProfileBody({ onDone }: { onDone: () => void }) {
  const { profile, save } = useProfile()
  const [draft, setDraft] = useState<ProfileDraft>(() => toDraft(profile))

  // A second tab can change the stored profile under this form. Adjusted during
  // render rather than in an effect: React restarts this render before touching
  // the DOM, so the form never paints the stale name for a frame.
  const [seen, setSeen] = useState(profile)
  if (profile !== seen) {
    setSeen(profile)
    setDraft(toDraft(profile))
  }

  const dirty =
    draft.name !== (profile?.name ?? '') ||
    draft.email !== (profile?.email ?? '') ||
    draft.accent !== (profile?.accent ?? DEFAULT_ACCENT)

  const valid = draft.name.trim() !== ''

  function commit() {
    if (!valid) return
    save({ name: draft.name.trim(), email: draft.email.trim(), accent: draft.accent })
    // Closing is the confirmation: the header wears the new name the moment
    // the dialog is out of the way.
    onDone()
  }

  return (
    <>
      <ProfileFields value={draft} onChange={setDraft} />

      {/* Signed out: the panel is the sign-in offer. Omitted entirely on a
          build with no Clerk key, where its hooks have no provider. */}
      {accountsEnabled ? (
        <div className="border-t border-border pt-4">
          <AccountPanel />
        </div>
      ) : null}

      <DialogFooter>
        <DialogClose asChild>
          <Button variant="outline">Cancel</Button>
        </DialogClose>
        <Button disabled={!dirty || !valid} onClick={commit}>
          Save changes
        </Button>
      </DialogFooter>
    </>
  )
}
