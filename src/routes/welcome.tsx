/**
 * First run: who you are, then what the app looks like.
 *
 * Nothing paints until Clerk has answered. The guards that route here read
 * localStorage synchronously and so cannot see a session that resolves a beat
 * later; a browser that has dropped this origin's storage (WebKit does after a
 * week idle) therefore sends a perfectly signed-in user to the welcome. Waiting
 * turns that into the app's ordinary centred spinner instead of a welcome that
 * flashes past on the way to the library.
 *
 * Two steps rather than one long form, because the second one repaints the
 * whole screen as you click and that only reads as a preview if it is the only
 * thing on screen at the time. The theme applies immediately on select — it is
 * already persisted by `useThemePresets`, so leaving halfway keeps the colours
 * and only loses the profile.
 *
 * The first step offers sign-in as an alternative to a local profile: a
 * signed-in user needs no local identity (see lib/profile/identity.ts) and no
 * setup at all, so the moment sign-in is known — whether it happened here or
 * on an earlier visit — the welcome marks itself done and leaves for the
 * library. Signed-in state is read from the identity store — the bridge in
 * the root layout mirrors Clerk into it — so this file renders on keyless
 * builds too; only the sign-in button itself is gated.
 */

import { useEffect, useState } from 'react'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { SignInButton } from '@clerk/react'
import { ArrowLeft, ArrowRight, Check } from 'lucide-react'

import { DEFAULT_ACCENT } from '@/components/profile/avatar-accent'
import { ProfileFields, type ProfileDraft } from '@/components/profile/profile-fields'
import { ModeChooser } from '@/components/theme/mode-chooser'
import { ThemePicker } from '@/components/theme/theme-picker'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { LoadingScreen } from '@/components/ui/loading-screen'
import { Skeleton } from '@/components/ui/skeleton'
import { useOnline } from '@/lib/offline/use-online'
import { useIdentity } from '@/lib/profile/identity'
import { hasOnboarded, hasProfile, markOnboarded } from '@/lib/profile/store'
import { useProfile } from '@/lib/profile/use-profile'
import { accountsEnabled } from '@/lib/sync/config'
import { useThemePresets } from '@/lib/theme/use-theme-presets'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/welcome')({
  beforeLoad: () => {
    // Reachable on purpose from Settings → Run welcome again, which clears
    // both the profile and the onboarded marker first; with either present
    // there is nothing to ask.
    if (hasProfile() || hasOnboarded()) throw redirect({ to: '/browse' })
  },
  component: Welcome,
})

const STEPS = ['Profile', 'Appearance'] as const

/**
 * How long to wait on Clerk before showing the welcome regardless.
 *
 * A first run with no network never resolves a session, and a spinner that
 * never ends is worse than a welcome shown to someone who turns out to be
 * signed in — the effect below still corrects that case the moment the answer
 * arrives.
 */
const ACCOUNT_WAIT_MS = 2500

function Welcome() {
  const navigate = useNavigate()
  const { save } = useProfile()
  const { signedIn, accountReady } = useIdentity()
  const online = useOnline()
  const [step, setStep] = useState<0 | 1>(0)
  const [waitedLongEnough, setWaitedLongEnough] = useState(false)
  const [draft, setDraft] = useState<ProfileDraft>({
    name: '',
    email: '',
    accent: DEFAULT_ACCENT,
  })

  // A signed-in user has nothing to set up: the account is the identity, and
  // no local profile is created. Fires both for "already signed in when the
  // welcome mounted" (Clerk resolves a beat after load, faster than typing)
  // and for the sign-in button below completing its modal. `replace`, so Back
  // does not return to a welcome that would immediately leave again.
  useEffect(() => {
    if (!signedIn) return
    markOnboarded()
    void navigate({ to: '/library', replace: true })
  }, [signedIn, navigate])

  useEffect(() => {
    const timer = setTimeout(() => setWaitedLongEnough(true), ACCOUNT_WAIT_MS)
    return () => clearTimeout(timer)
  }, [])

  const name = draft.name.trim()
  const valid = name !== ''
  const firstName = name.split(/\s+/)[0] ?? ''

  function finish() {
    save({ name, email: draft.email.trim(), accent: draft.accent })
    // Marked alongside the profile so one flag means "welcome done"
    // everywhere; see hasOnboarded in lib/profile/store.ts.
    markOnboarded()
    void navigate({ to: '/browse' })
  }

  // After the hooks above, so the hook order does not change when the answer
  // arrives. `LoadingScreen` stays blank for its first 150ms, so the common
  // case — Clerk resolving quickly — shows no spinner at all.
  //
  // Held while signed in as well, and not only while the answer is pending:
  // the redirect above runs in an effect, which React flushes *after* the
  // browser has painted, so releasing the gate the instant Clerk answers puts
  // a full frame of welcome on screen on the way to the library. Waiting here
  // means a signed-in user only ever sees the spinner.
  //
  // Offline there is no answer coming at all — Clerk's script cannot load —
  // so the wait is skipped rather than served as two and a half seconds of
  // spinner on a first run with no connection.
  if (signedIn || (!accountReady && !waitedLongEnough && online)) {
    return <LoadingScreen />
  }

  return (
    <div className="flex min-h-full items-center justify-center px-page py-8 sm:py-12">
      <div className="flex w-full max-w-xl flex-col gap-6">
        <header>
          <p className="font-brand text-xs tracking-wide text-muted-foreground uppercase">
            Kagi
          </p>
          <h1 className="mt-2 max-w-[24ch] text-3xl font-semibold tracking-tight text-balance">
            {step === 0 ? 'Welcome.' : `Nice to meet you, ${firstName}.`}
          </h1>
          <p className="mt-2 max-w-[56ch] text-base text-pretty text-muted-foreground sm:text-sm">
            {step === 0
              ? 'Your library, your reader, your device. Set up a profile so the app knows who to greet — it never leaves this browser.'
              : 'Pick how it should look. Every theme carries a light and a dark palette, and the whole app changes the moment you choose.'}
          </p>
        </header>

        <StepIndicator current={step} />

        {step === 0 ? (
          <ProfileStep value={draft} onChange={setDraft} />
        ) : (
          <AppearanceStep />
        )}

        <footer className="flex items-center gap-2 border-t border-border pt-4">
          {step === 1 ? (
            <Button variant="ghost" size="sm" onClick={() => setStep(0)}>
              <ArrowLeft />
              Back
            </Button>
          ) : null}

          <div className="ml-auto flex items-center gap-2">
            {step === 0 ? (
              <Button size="sm" disabled={!valid} onClick={() => setStep(1)}>
                Continue
                <ArrowRight />
              </Button>
            ) : (
              <Button size="sm" onClick={finish}>
                <Check />
                Finish
              </Button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}

function StepIndicator({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-2" role="list">
      {STEPS.map((label, index) => (
        <li key={label} className="flex flex-1 flex-col gap-1.5">
          <span
            className={cn(
              'h-1 rounded-full',
              index <= current ? 'bg-primary' : 'bg-border',
            )}
            aria-hidden
          />
          <span
            className={cn(
              'text-xs',
              index === current ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {label}
          </span>
        </li>
      ))}
    </ol>
  )
}

function ProfileStep({
  value,
  onChange,
}: {
  value: ProfileDraft
  onChange: (next: ProfileDraft) => void
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <ProfileFields value={value} onChange={onChange} />

      {/* The gate is the build-time key, not a hook: `SignInButton` needs the
          ClerkProvider that keyless builds do not mount. */}
      {accountsEnabled ? (
        <div className="mt-4 border-t border-border pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-muted-foreground uppercase">or</span>
            <SignInButton mode="modal">
              <Button variant="outline" size="sm">
                Sign in
              </Button>
            </SignInButton>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            An account is optional — the app is free forever and everything is
            saved on this device either way. Signing in skips setup and takes
            you straight to your library; the Sync plan for keeping devices in
            step can be added later.
          </p>
        </div>
      ) : null}
    </section>
  )
}

function AppearanceStep() {
  const themes = useThemePresets()

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-2">
        <Label>Mode</Label>
        <ModeChooser />
      </div>

      <div className="flex flex-col gap-2">
        <Label>Theme</Label>

        {themes.custom.length > 0 ? (
          <ThemePicker
            presets={themes.custom}
            activeId={themes.activeId}
            onSelect={themes.select}
          />
        ) : null}

        {/* The catalog is a quarter of a megabyte and loads after the tab
            opens, so the grid grows under the pointer; the skeletons hold the
            space rather than letting the Finish button jump. */}
        <div className="max-h-72 overflow-y-auto pr-1">
          <ThemePicker
            presets={themes.builtIn}
            activeId={themes.activeId}
            onSelect={themes.select}
          />

          {themes.loading ? (
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} className="h-[70px] rounded-lg" />
              ))}
            </div>
          ) : null}
        </div>

        <p className="text-xs text-muted-foreground">
          You can change any of this later in Settings → Appearance.
        </p>
      </div>
    </section>
  )
}
